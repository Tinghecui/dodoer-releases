// 和 CoTeam 服务端返回一样形状的 `cowork_team` 样例（#1230 契约）：
// 组、留言、进组提示的编号都是 JSON 数字，会话号 `id`、`owner` 是文字。
// 测试把它们读进来，再原样传回发请求的包装函数，确认发出去的还是同一个数字。
// 账户都是编的：alice（爱丽丝）、bob（鲍勃），组「预发测试组」编号 1。

export const TEAM_CONTRACT_FIXTURE = {
  status: {
    applicable: true,
    enabled: true,
    me: { name: "bob", label: "鲍勃" },
    leaderOf: [{ id: 1, name: "预发测试组" }],
    portalUrl: "https://portal.example.com",
  },
  summary: {
    sharedNew: 1,
    commentUnread: {
      total: 2,
      sessions: [
        {
          owner: "alice",
          ownerLabel: "爱丽丝",
          id: "75",
          title: "修登录",
          mine: false,
          count: 2,
        },
      ],
    },
    groupNotices: [{ id: 3, groupName: "预发测试组", leaders: ["鲍勃"] }],
  },
  targets: {
    users: [{ name: "bob", label: "鲍勃" }],
    groups: [{ id: 1, name: "预发测试组" }],
  },
  shares: {
    id: "75",
    shares: [
      {
        type: "user",
        name: "bob",
        label: "鲍勃",
        note: "",
        createdAt: "2026-11-23T08:00:00Z",
      },
      {
        type: "group",
        id: 1,
        name: "预发测试组",
        note: "看看",
        createdAt: "2026-11-23T08:01:00Z",
      },
    ],
  },
  comments: {
    isOwner: false,
    ids: [9, 10],
    comments: [
      {
        id: 9,
        seq: 4,
        parentId: null,
        author: "bob",
        authorLabel: "鲍勃",
        former: false,
        body: "这里要再查一下",
        createdAt: "2026-11-23T08:02:00Z",
        mine: false,
        canDelete: false,
        anchor: null,
      },
      {
        id: 10,
        seq: null,
        parentId: 9,
        author: "alice",
        authorLabel: "爱丽丝",
        former: false,
        body: "好的",
        createdAt: "2026-11-23T08:03:00Z",
        mine: true,
        canDelete: true,
        anchor: null,
      },
    ],
  },
  shared: [
    {
      owner: "alice",
      ownerLabel: "爱丽丝",
      id: "75",
      title: "修登录",
      state: "waiting",
      updatedAt: "2026-11-23T08:04:00Z",
      note: "看看",
      sharedAt: "2026-11-23T08:01:00Z",
      isNew: true,
      summary: null,
      via: [{ type: "user" }, { type: "group", id: 1, name: "预发测试组" }],
    },
  ],
  team: {
    id: 1,
    name: "预发测试组",
    since: "2026-11-23T00:00:00+08:00",
    members: [
      {
        name: "alice",
        label: "爱丽丝",
        running: 0,
        waiting: 1,
        sessions: [
          {
            owner: "alice",
            id: "75",
            title: "修登录",
            state: "waiting",
            updatedAt: "2026-11-23T08:04:00Z",
            summary: null,
          },
        ],
      },
    ],
  },
} as const
