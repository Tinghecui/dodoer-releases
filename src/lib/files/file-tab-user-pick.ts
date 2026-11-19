// 用户在标签栏上点了、拖了哪个文件标签：标签栏直接告诉持久化，不靠它从标签栏的
// 变化里猜。恢复期间第一个恢复出来的标签是工作区自己选上的，用户再点它，选中项
// 没变，标签栏看不出任何变化，持久化会以为用户没选过，恢复完又选回刷新前记下的那个。
//
// 一个文档一份，只是个广播：没人订阅就什么都不做。

type Listener = (tabId: string) => void

const listeners = new Set<Listener>()

/** 标签栏上用户点了、开始拖动了这个标签时调（点的是已经选中的也要调）。 */
export function noteUserPickedFileTab(tabId: string): void {
  for (const listener of [...listeners]) listener(tabId)
}

/** 订阅用户点、拖标签；返回取消订阅的函数。 */
export function subscribeUserPickedFileTab(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
