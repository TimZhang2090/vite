import type { Update } from 'types/hmrPayload'
import type { ModuleNamespace, ViteHotContext } from 'types/hot'
import type { InferCustomEventPayload } from 'types/customEvent'

type CustomListenersMap = Map<string, ((data: any) => void)[]>

interface HotModule {
  id: string
  callbacks: HotCallback[]
}

interface HotCallback {
  // the dependencies must be fetchable paths
  deps: string[]
  fn: (modules: Array<ModuleNamespace | undefined>) => void
}

interface Connection {
  addBuffer(message: string): void
  send(): unknown
}

export class HMRContext implements ViteHotContext {
  private newListeners: CustomListenersMap

  constructor(
    private ownerPath: string,
    private hmrClient: HMRClient,
    private connection: Connection,
  ) {
    if (!hmrClient.dataMap.has(ownerPath)) {
      hmrClient.dataMap.set(ownerPath, {})
    }

    // when a file is hot updated, a new context is created
    // clear its stale callbacks
    const mod = hmrClient.hotModulesMap.get(ownerPath)
    if (mod) {
      mod.callbacks = []
    }

    // clear stale custom event listeners
    const staleListeners = hmrClient.ctxToListenersMap.get(ownerPath)
    if (staleListeners) {
      for (const [event, staleFns] of staleListeners) {
        const listeners = hmrClient.customListenersMap.get(event)
        if (listeners) {
          hmrClient.customListenersMap.set(
            event,
            listeners.filter((l) => !staleFns.includes(l)),
          )
        }
      }
    }

    this.newListeners = new Map()
    hmrClient.ctxToListenersMap.set(ownerPath, this.newListeners)
  }

  get data(): any {
    return this.hmrClient.dataMap.get(this.ownerPath)
  }

  accept(deps?: any, callback?: any): void {
    if (typeof deps === 'function' || !deps) {
      // self-accept: hot.accept(() => {})
      this.acceptDeps([this.ownerPath], ([mod]) => deps?.(mod))
    } else if (typeof deps === 'string') {
      // explicit deps
      this.acceptDeps([deps], ([mod]) => callback?.(mod))
    } else if (Array.isArray(deps)) {
      this.acceptDeps(deps, callback)
    } else {
      throw new Error(`invalid hot.accept() usage.`)
    }
  }

  // export names (first arg) are irrelevant on the client side, they're
  // extracted in the server for propagation
  acceptExports(
    _: string | readonly string[],
    callback: (data: any) => void,
  ): void {
    this.acceptDeps([this.ownerPath], ([mod]) => callback?.(mod))
  }

  dispose(cb: (data: any) => void): void {
    this.hmrClient.disposeMap.set(this.ownerPath, cb)
  }

  prune(cb: (data: any) => void): void {
    this.hmrClient.pruneMap.set(this.ownerPath, cb)
  }

  // Kept for backward compatibility (#11036)
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  decline(): void {}

  invalidate(message: string): void {
    this.hmrClient.notifyListeners('vite:invalidate', {
      path: this.ownerPath,
      message,
    })
    this.send('vite:invalidate', { path: this.ownerPath, message })
    this.hmrClient.logger.debug(
      `[vite] invalidate ${this.ownerPath}${message ? `: ${message}` : ''}`,
    )
  }

  on<T extends string>(
    event: T,
    cb: (payload: InferCustomEventPayload<T>) => void,
  ): void {
    const addToMap = (map: Map<string, any[]>) => {
      const existing = map.get(event) || []
      existing.push(cb)
      map.set(event, existing)
    }
    addToMap(this.hmrClient.customListenersMap)
    addToMap(this.newListeners)
  }

  off<T extends string>(
    event: T,
    cb: (payload: InferCustomEventPayload<T>) => void,
  ): void {
    const removeFromMap = (map: Map<string, any[]>) => {
      const existing = map.get(event)
      if (existing === undefined) {
        return
      }
      const pruned = existing.filter((l) => l !== cb)
      if (pruned.length === 0) {
        map.delete(event)
        return
      }
      map.set(event, pruned)
    }
    removeFromMap(this.hmrClient.customListenersMap)
    removeFromMap(this.newListeners)
  }

  send<T extends string>(event: T, data?: InferCustomEventPayload<T>): void {
    this.connection.addBuffer(JSON.stringify({ type: 'custom', event, data }))
    this.connection.send()
  }

  private acceptDeps(
    deps: string[],
    callback: HotCallback['fn'] = () => {},
  ): void {
    const mod: HotModule = this.hmrClient.hotModulesMap.get(this.ownerPath) || {
      id: this.ownerPath,
      callbacks: [],
    }
    mod.callbacks.push({
      deps,
      fn: callback,
    })

    // tim 这个 map 用来存每个模块中所有用 accept 注册的 cb
    this.hmrClient.hotModulesMap.set(this.ownerPath, mod)
  }
}

export class HMRClient {
  public hotModulesMap = new Map<string, HotModule>()
  public disposeMap = new Map<string, (data: any) => void | Promise<void>>()
  public pruneMap = new Map<string, (data: any) => void | Promise<void>>()
  public dataMap = new Map<string, any>()
  public customListenersMap: CustomListenersMap = new Map()
  public ctxToListenersMap = new Map<string, CustomListenersMap>()

  constructor(
    public logger: Console,
    // this allows up to implement reloading via different methods depending on the environment
    private importUpdatedModule: (update: Update) => Promise<ModuleNamespace>,
  ) {}

  public async notifyListeners<T extends string>(
    event: T,
    data: InferCustomEventPayload<T>,
  ): Promise<void>
  public async notifyListeners(event: string, data: any): Promise<void> {
    const cbs = this.customListenersMap.get(event)
    if (cbs) {
      await Promise.allSettled(cbs.map((cb) => cb(data)))
    }
  }

  // After an HMR update, some modules are no longer imported on the page
  // but they may have left behind side effects that need to be cleaned up
  // (.e.g style injections)
  // TODO Trigger their dispose callbacks.
  public prunePaths(paths: string[]): void {
    paths.forEach((path) => {
      const fn = this.pruneMap.get(path)
      if (fn) {
        fn(this.dataMap.get(path))
      }
    })
  }

  protected warnFailedUpdate(err: Error, path: string | string[]): void {
    if (!err.message.includes('fetch')) {
      this.logger.error(err)
    }
    this.logger.error(
      `[hmr] Failed to reload ${path}. ` +
        `This could be due to syntax errors or importing non-existent ` +
        `modules. (see errors above)`,
    )
  }

  // tim fetchUpdate 返回的函数执行一次，仅触发一个 `持有模块`(边界模块) 执行一遍更新逻辑
  // payload.updates 是一个数组，可能包含多个接受 当前变化模块 的 边界模块
  // 所以当 server 端推动变动模块的信息的时候，如果其有多个上级 边界模块，fetchUpdate 是会被执行多次的
  // 所以 fetchUpdate 返回的函数又传给了 queueUpdate
  public async fetchUpdate(update: Update): Promise<(() => void) | undefined> {
    const { path, acceptedPath } = update
    const mod = this.hotModulesMap.get(path)
    if (!mod) {
      // In a code-splitting project,
      // it is common that the hot-updating module is not loaded yet.
      // https://github.com/vitejs/vite/issues/721
      return
    }

    let fetchedModule: ModuleNamespace | undefined
    const isSelfUpdate = path === acceptedPath

    // determine the qualified callbacks before we re-import the modules
    const qualifiedCallbacks = mod.callbacks.filter(({ deps }) =>
      deps.includes(acceptedPath),
    )

    if (isSelfUpdate || qualifiedCallbacks.length > 0) {
      // tim 如果模块有通过 hot.dispose() 注册失活回调函数，先执行失活函数
      const disposer = this.disposeMap.get(acceptedPath)
      if (disposer) await disposer(this.dataMap.get(acceptedPath))

      try {
        // tim 请求发生变化的模块
        fetchedModule = await this.importUpdatedModule(update)
      } catch (e) {
        this.warnFailedUpdate(e, acceptedPath)
      }
    }

    // tim 返回一个函数，用来执行所有的更新回调
    return () => {
      for (const { deps, fn } of qualifiedCallbacks) {
        // tim 执行回调，并传入更新后的模块
        fn(
          deps.map((dep) => (dep === acceptedPath ? fetchedModule : undefined)),
        )
      }
      const loggedPath = isSelfUpdate ? path : `${acceptedPath} via ${path}`
      this.logger.debug(`[vite] hot updated: ${loggedPath}`)
    }
  }
}
