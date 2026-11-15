//! Cowork fork: a model switch the user can follow.
//!
//! Upstream sends the pick and the composer shows it at once, whether or not
//! the agent took it; a pick made while a reply runs reaches the agent
//! mid-reply. Here a switch of the model selector goes through phases
//! ([`ModelSwitchPhase`]), each an [`AcpEvent::ModelSwitch`]:
//!
//! - `Pending` while the agent is asked, at most [`MODEL_SWITCH_TIMEOUT`];
//! - `AfterTurn` when it was asked for during a reply: the reply finishes on
//!   the model it started with, and the switch is sent once it has ended
//!   ([`hold`], [`apply_held`]);
//! - then `Applied` when the agent reports the new model, `Failed` otherwise,
//!   or `Cancelled` when a newer pick replaced one that was still waiting.
//!
//! The switch under way rides the snapshot (`SessionState.model_switch`); the
//! lifecycle worker keeps the settled ones as the conversation's timeline
//! (`session_prefs::record_model_switch`). A failed switch is reported by its
//! `Failed` phase alone — the client's toast and timeline line say which model
//! is still in use — not by the generic `set_config_option_failed` error too.

use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::SessionId;
use agent_client_protocol::{Agent, ConnectionTo};
use tokio::sync::RwLock;

use crate::acp::connection::{
    set_config_option_for_agent, SetterOutcome, SetterReply, SET_CONFIG_OPTION_FAILED_ERROR_CODE,
};
use crate::acp::session_state::SessionState;
use crate::acp::types::{
    AcpEvent, ModelSwitchInfo, ModelSwitchPhase, SessionConfigKindInfo, SessionConfigSelectInfo,
};
use crate::models::agent::AgentType;
use crate::web::event_bridge::{emit_with_state, EventEmitter};

/// How long a switch waits for the agent's answer before it counts as failed.
pub(crate) const MODEL_SWITCH_TIMEOUT: Duration = Duration::from_secs(10);

/// What a switch that ran out of time fails with.
const NO_ANSWER: &str = "the agent did not answer within 10 seconds";

/// The category codeg maps an agent's model selector to.
const MODEL_CATEGORY: &str = "model";

/// A switch asked for while a reply was running, held until the reply ends.
pub(crate) struct HeldModelSwitch {
    switch: ModelSwitchInfo,
    reply: Option<SetterReply>,
}

/// Whether `config_id` is the session's model selector.
pub(crate) async fn is_model_option(state: &Arc<RwLock<SessionState>>, config_id: &str) -> bool {
    let s = state.read().await;
    let options = s.config_options.as_deref().unwrap_or_default();
    options.iter().any(|o| {
        o.id == config_id
            && o.category.as_deref() == Some(MODEL_CATEGORY)
            && matches!(o.kind, SessionConfigKindInfo::Select(_))
    })
}

/// A select value's display name; the value itself when the list lacks it.
fn option_name(select: &SessionConfigSelectInfo, value: &str) -> String {
    let grouped = select.groups.iter().flat_map(|g| g.options.iter());
    select
        .options
        .iter()
        .chain(grouped)
        .find(|item| item.value == value)
        .map(|item| item.name.clone())
        .unwrap_or_else(|| value.to_string())
}

/// The model `config_id` holds now, as `(value, display name)`.
async fn current_model(
    state: &Arc<RwLock<SessionState>>,
    config_id: &str,
) -> Option<(String, String)> {
    let s = state.read().await;
    let options = s.config_options.as_deref()?;
    let option = options.iter().find(|o| o.id == config_id)?;
    let SessionConfigKindInfo::Select(select) = &option.kind else {
        return None;
    };
    let value = select.current_value.clone();
    let name = option_name(select, &value);
    Some((value, name))
}

/// A new switch of `config_id` to `value_id`, in `phase`. `None` when the
/// option is not the model selector, or already holds `value_id`.
async fn new_switch(
    state: &Arc<RwLock<SessionState>>,
    config_id: &str,
    value_id: &str,
    phase: ModelSwitchPhase,
) -> Option<ModelSwitchInfo> {
    let s = state.read().await;
    let options = s.config_options.as_deref()?;
    let option = options.iter().find(|o| o.id == config_id)?;
    if option.category.as_deref() != Some(MODEL_CATEGORY) {
        return None;
    }
    let SessionConfigKindInfo::Select(select) = &option.kind else {
        return None;
    };
    if select.current_value == value_id {
        return None;
    }
    Some(ModelSwitchInfo {
        id: uuid::Uuid::new_v4().to_string(),
        config_id: config_id.to_string(),
        phase,
        from_value: select.current_value.clone(),
        from_name: option_name(select, &select.current_value),
        to_value: value_id.to_string(),
        to_name: option_name(select, value_id),
        failure: None,
        detail: None,
        after_turn: phase == ModelSwitchPhase::AfterTurn,
        at: chrono::Utc::now(),
        conversation_id: s.conversation_id,
    })
}

async fn announce(
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    switch: &ModelSwitchInfo,
) {
    let event = AcpEvent::ModelSwitch {
        switch: switch.clone(),
    };
    emit_with_state(state, emitter, event).await;
}

fn answer(reply: Option<SetterReply>, outcome: Result<SetterOutcome, String>) {
    if let Some(reply) = reply {
        // A caller that stopped waiting is not an error.
        let _ = reply.send(outcome);
    }
}

/// `set_config_option_for_agent` as the idle loop runs it: a model switch is
/// reported as it goes (see the module docs); anything else is set as before,
/// a failure reported as the recoverable error it always was. Errors as text,
/// the way a setter reply carries them.
pub(crate) async fn set_config_option(
    agent_type: AgentType,
    cx: &ConnectionTo<Agent>,
    sid: &SessionId,
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    config_id: String,
    value_id: String,
) -> Result<SetterOutcome, String> {
    let pending = ModelSwitchPhase::Pending;
    if let Some(switch) = new_switch(state, &config_id, &value_id, pending).await {
        return run(agent_type, cx, sid, state, emitter, switch).await;
    }
    let (id, value) = (config_id, value_id);
    let set = set_config_option_for_agent(agent_type, cx, sid, state, emitter, id, value);
    let e = match set.await {
        Ok(outcome) => return Ok(outcome),
        Err(e) => e,
    };
    let event = AcpEvent::Error {
        message: format!("Failed to set config option: {e}"),
        agent_type: agent_type.to_string(),
        code: Some(SET_CONFIG_OPTION_FAILED_ERROR_CODE.to_string()),
        details: None,
        // Recoverable: idle SetConfigOption failure leaves the connection
        // alive.
        terminal: false,
    };
    emit_with_state(state, emitter, event).await;
    Err(e.to_string())
}

/// Send `switch` to the agent and settle it against what the agent reports
/// afterwards.
async fn run(
    agent_type: AgentType,
    cx: &ConnectionTo<Agent>,
    sid: &SessionId,
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    mut switch: ModelSwitchInfo,
) -> Result<SetterOutcome, String> {
    switch.phase = ModelSwitchPhase::Pending;
    switch.at = chrono::Utc::now();
    announce(state, emitter, &switch).await;
    let (id, value) = (switch.config_id.clone(), switch.to_value.clone());
    let set = set_config_option_for_agent(agent_type, cx, sid, state, emitter, id, value);
    let result = match tokio::time::timeout(MODEL_SWITCH_TIMEOUT, set).await {
        Ok(answer) => answer.map_err(|e| e.to_string()),
        Err(_) => Err(NO_ANSWER.to_string()),
    };
    let (error, refused) = match &result {
        Err(message) => (Some(message.as_str()), false),
        Ok(SetterOutcome::Refused { message }) => (Some(message.as_str()), true),
        Ok(_) => (None, false),
    };
    let now = current_model(state, &switch.config_id).await;
    settle(&mut switch, error, now);
    // A refusal is a failure all the same, one the connection has already
    // reported in its own words: the client draws its line, no second toast.
    if refused {
        switch.failure = Some("refused".to_string());
    }
    switch.conversation_id = state.read().await.conversation_id;
    announce(state, emitter, &switch).await;
    result
}

/// The settled phase of `switch`, given the setter's error (if it failed) and
/// the model the agent reports now.
fn settle(switch: &mut ModelSwitchInfo, error: Option<&str>, now: Option<(String, String)>) {
    switch.at = chrono::Utc::now();
    switch.phase = ModelSwitchPhase::Failed;
    match (error, now) {
        (Some(message), _) => {
            let failure = if message == NO_ANSWER {
                "no_answer"
            } else {
                "agent_error"
            };
            switch.failure = Some(failure.to_string());
            switch.detail = Some(message.to_string());
        }
        (None, Some((value, _))) if value == switch.to_value => {
            switch.phase = ModelSwitchPhase::Applied;
        }
        (None, now) => {
            switch.failure = Some("not_adopted".to_string());
            switch.detail = now.map(|(_, name)| name);
        }
    }
}

/// A pick of the model selector made while a reply runs: kept in `held` (as
/// `AfterTurn`) until [`apply_held`] sends it after the reply. A newer pick
/// replaces one still waiting, and a pick of the model in effect just drops it.
pub(crate) async fn hold(
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    held: &mut Vec<HeldModelSwitch>,
    config_id: String,
    value_id: String,
    reply: Option<SetterReply>,
) {
    if let Some(i) = held.iter().position(|h| h.switch.config_id == config_id) {
        let replaced = held.remove(i);
        let mut switch = replaced.switch;
        switch.phase = ModelSwitchPhase::Cancelled;
        switch.at = chrono::Utc::now();
        announce(state, emitter, &switch).await;
        answer(replaced.reply, Ok(SetterOutcome::NotExecuted));
    }
    let after_turn = ModelSwitchPhase::AfterTurn;
    match new_switch(state, &config_id, &value_id, after_turn).await {
        Some(switch) => {
            announce(state, emitter, &switch).await;
            held.push(HeldModelSwitch { switch, reply });
        }
        // The model already in effect: nothing to wait for.
        None => answer(reply, Ok(SetterOutcome::Confirmed { current: value_id })),
    }
}

/// Send the switches [`hold`] kept, now that the reply they waited for has
/// ended.
pub(crate) async fn apply_held(
    agent_type: AgentType,
    cx: &ConnectionTo<Agent>,
    sid: &SessionId,
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    held: Vec<HeldModelSwitch>,
) {
    for HeldModelSwitch { switch, reply } in held {
        let result = run(agent_type, cx, sid, state, emitter, switch).await;
        answer(reply, result);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::types::{
        SessionConfigOptionInfo, SessionConfigSelectGroupInfo, SessionConfigSelectOptionInfo,
    };

    fn item(value: &str, name: &str) -> SessionConfigSelectOptionInfo {
        SessionConfigSelectOptionInfo {
            value: value.to_string(),
            name: name.to_string(),
            description: None,
        }
    }

    fn model_option(current: &str) -> SessionConfigOptionInfo {
        SessionConfigOptionInfo {
            id: "model".to_string(),
            name: "Model".to_string(),
            description: None,
            category: Some(MODEL_CATEGORY.to_string()),
            kind: SessionConfigKindInfo::Select(SessionConfigSelectInfo {
                current_value: current.to_string(),
                options: vec![item("opus", "Opus 5.5")],
                groups: vec![SessionConfigSelectGroupInfo {
                    group: "more".to_string(),
                    name: "More".to_string(),
                    options: vec![item("fable", "Fable 5.1")],
                }],
            }),
            recommended_value: None,
        }
    }

    fn state_with(options: Vec<SessionConfigOptionInfo>) -> Arc<RwLock<SessionState>> {
        let mut state = SessionState::new(
            "c1".to_string(),
            AgentType::ClaudeCode,
            None,
            "test-window".to_string(),
            None,
        );
        state.conversation_id = Some(7);
        state.config_options = Some(options);
        Arc::new(RwLock::new(state))
    }

    #[tokio::test]
    async fn a_switch_names_both_models() {
        let state = state_with(vec![model_option("opus")]);
        let phase = ModelSwitchPhase::AfterTurn;
        let switch = new_switch(&state, "model", "fable", phase).await.unwrap();
        assert_eq!(switch.from_name, "Opus 5.5");
        assert_eq!(switch.to_name, "Fable 5.1");
        assert!(switch.after_turn);
        assert_eq!(switch.conversation_id, Some(7));
    }

    #[tokio::test]
    async fn only_a_change_of_the_model_selector_is_a_switch() {
        let mut effort = model_option("high");
        effort.id = "effort".to_string();
        effort.category = Some("thought_level".to_string());
        let state = state_with(vec![model_option("opus"), effort]);
        let phase = ModelSwitchPhase::Pending;
        assert!(new_switch(&state, "model", "opus", phase).await.is_none());
        assert!(new_switch(&state, "effort", "low", phase).await.is_none());
        assert!(is_model_option(&state, "model").await);
        assert!(!is_model_option(&state, "effort").await);
    }

    #[tokio::test]
    async fn a_held_switch_is_replaced_by_a_newer_pick_and_dropped_by_the_current_one() {
        let state = state_with(vec![model_option("opus")]);
        let emitter = EventEmitter::Noop;
        let mut held = Vec::new();
        let (id, fable) = ("model".to_string(), "fable".to_string());
        hold(&state, &emitter, &mut held, id.clone(), fable, None).await;
        assert_eq!(held.len(), 1);
        let waiting = state.read().await.model_switch.clone().unwrap();
        assert_eq!(waiting.phase, ModelSwitchPhase::AfterTurn);

        let (tx, rx) = tokio::sync::oneshot::channel();
        let opus = "opus".to_string();
        hold(&state, &emitter, &mut held, id, opus, Some(tx)).await;
        assert!(held.is_empty());
        assert!(state.read().await.model_switch.is_none());
        let want = SetterOutcome::Confirmed {
            current: "opus".to_string(),
        };
        assert_eq!(rx.await.unwrap(), Ok(want));
    }

    #[test]
    fn settling_reads_what_the_agent_reports() {
        let mut switch = ModelSwitchInfo {
            id: "s".to_string(),
            config_id: "model".to_string(),
            phase: ModelSwitchPhase::Pending,
            from_value: "opus".to_string(),
            from_name: "Opus 5.5".to_string(),
            to_value: "fable".to_string(),
            to_name: "Fable 5.1".to_string(),
            failure: None,
            detail: None,
            after_turn: false,
            at: chrono::Utc::now(),
            conversation_id: None,
        };
        let fable = Some(("fable".to_string(), "Fable 5.1".to_string()));
        settle(&mut switch, None, fable);
        assert_eq!(switch.phase, ModelSwitchPhase::Applied);

        let opus = Some(("opus".to_string(), "Opus 5.5".to_string()));
        settle(&mut switch, None, opus.clone());
        assert_eq!(switch.phase, ModelSwitchPhase::Failed);
        assert_eq!(switch.failure.as_deref(), Some("not_adopted"));
        assert_eq!(switch.detail.as_deref(), Some("Opus 5.5"));

        settle(&mut switch, Some(NO_ANSWER), opus);
        assert_eq!(switch.failure.as_deref(), Some("no_answer"));
    }
}
