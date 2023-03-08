type MiddlewareType<T, U extends keyof T> = (New: T[U], Old: T[U]) => T[U];

// Deepcopy implementation (luau only!)
const DeepCopy = <T extends object>(Object: T): T => {
	const Copy: Record<string, unknown> = {};

	for (const [Key, Val] of pairs(Object)) {
		if (typeIs(Val, "table")) {
			Copy[Key as string] = DeepCopy(Val);
		} else {
			Copy[Key as string] = Val;
		}
	}
	return Copy as T;
};

export class Crate<T extends defined> {
	private State: T;
	private CrateOpen = true;
	private UpdateBind: BindableEvent;
	private Connections: RBXScriptConnection[] = [];
	private InitialState: T;
	private MiddlewareMap = new Map<unknown, unknown>();

	/**
	 * Create a new crate with an initial state.
	 *
	 * Crates are open by default, but can be closed with `Close()`
	 *
	 * @param InitialState Object
	 * @param Closed Set the crate to closed by default.
	 */
	constructor(InitialState: T, Closed = false) {
		this.State = InitialState;
		this.InitialState = DeepCopy(InitialState);
		this.UpdateBind = new Instance("BindableEvent", script);
		this.CrateOpen = !Closed;
	}

	// Internal method to execute middleware.
	private ExecuteMiddleware<U extends keyof T>(Key: U, New: T[U], Old: T[U]): T[U] {
		const MW_EXEC_TIME = tick();

		const Method = this.MiddlewareMap.get(Key) as MiddlewareType<T, U>;
		const Result = Method !== undefined ? Method(New, Old) : New;

		if (tick() - MW_EXEC_TIME > 0.2)
			warn("[Crate] ERROR: Yeilding is prohibited within middleware to prevent unexpected behavior.");

		return Result;
	}

	/**
	 * Create middleware that will run before the store is updated.
	 *
	 * The key's value will be set to the return value of this method.
	 *
	 * ```
	 * const MyCrate = new Crate( { Health: 100 } )
	 *
	 * MyCrate.Middleware("Health", (New, Old) => {
	 * 	return math.clamp(New, 0, 100)
	 * })
	 *
	 * MyCrate.Update("Health", -10) // 0
	 * MyCrate.Update("Health", 150) // 100
	 * ```
	 */
	Middleware<U extends keyof T>(Key: U, Middleware: (New: T[U], Old: T[U]) => T[U]): void {
		this.MiddlewareMap.set(Key, Middleware);
	}

	/**
	 * Listen for changes on a specific key.
	 *
	 * If the crate is closed, this event will not fire.
	 *
	 * Usage:
	 * ```
	 * const MyCrate = new Crate({MyNum: 10})
	 *
	 * MyCrate.OnUpdate("MyNum", (New, Old) => {
	 *  print(New, Old) // 5 & 10
	 * })
	 * ```
	 */
	OnUpdate<U extends keyof T>(Key: U, Callback: (NewData: T[U], OldData: T[U]) => void): RBXScriptConnection;
	/**
	 * Listen for changes on the entire crate.
	 *
	 * If the crate is closed, this event will not fire.
	 *
	 * Usage:
	 * ```
	 * const MyCrate = new Crate({MyNum: 10})
	 *
	 * MyCrate.OnUpdate((NewStore, OldStore) => {
	 *  print(New.MyNum, Old.MyNum) // 5 & 10
	 * })
	 * ```
	 */
	OnUpdate<U extends keyof T>(Callback: (NewData: T, OldData: T) => void): RBXScriptConnection;
	OnUpdate<U extends keyof T>(Key: U, Callback = Key as unknown): RBXScriptConnection {
		const Call = Callback as (NewData: T[U] | T, OldData: T[U] | T) => void;

		const Event = this.UpdateBind.Event.Connect((K: U, O: T[U], N: T[U]) =>
			Key !== Callback
				? Key === K && Call(N, O)
				: (() => {
						const Old = DeepCopy(this.State);
						Old[K] = O;
						Call(DeepCopy(this.State), Old);
				  })(),
		);

		this.Connections.push(Event);

		return Event;
	}

	/**
	 * Update a value within the crate.
	 *
	 * Usage:
	 * ```
	 * const MyCrate = new Crate( { MyNum: 10 } )
	 * MyCrate.Update("MyNum", 5)
	 * ```
	 */
	Update<U extends keyof T>(Key: U, Value?: T[U]): T[U];
	/**
	 * Update multiple values within the crate.
	 *
	 * Usage:
	 * ```
	 * const MyCrate = new Crate( { MyNum: 10 } )
	 * MyCrate.Update({
	 * 	MyNum: 5
	 * })
	 * ```
	 */
	Update<U extends keyof T>(Dispatch: Record<U, T[U]>): void;
	Update<U extends keyof T>(Key: unknown, Value?: unknown) {
		if (typeIs(Key, "table")) {
			for (const [K, V] of pairs(Key)) {
				this.Update(K as U, V as T[U]);
			}
		} else {
			const Old = this.State[Key as U];

			if (!this.CrateOpen) return Value;

			const Result = this.ExecuteMiddleware(Key as U, Value as T[U], Old);

			this.State[Key as U] = Result;
			this.UpdateBind.Fire(Key as U, Old, Result);

			return Old;
		}
	}

	/**
	 * Increment a given Key by a specified amount.
	 *
	 * If the Key[Val]'s type is NaN, this method will throw a warning. It will not mutate the state.
	 */
	Increment<U extends keyof T>(Key: U, Amount: number): T[U] {
		if (!typeIs(this.State[Key], "number")) {
			warn("[Crate] Attempt to increment a non-integer.");
			return this.State[Key];
		}

		const Old = this.State[Key];
		const New = (Old as number) + Amount;

		const Result = this.ExecuteMiddleware(Key as U, New as T[U], Old);

		this.State[Key] = Result;
		this.UpdateBind.Fire(Key as U, Old, Result);

		return Old;
	}

	/**
	 * Get a deep-copy of the data within the crate.
	 *
	 * Usage:
	 * ```
	 * const MyCrate = new Crate({ MyNum: 10 })
	 * const MyAwesomeValue = MyCrate.Get()
	 *       ^ { MyNum: 10 }
	 * ```
	 */
	Get(): T;
	/**
	 * Get the value of a key in the crate.
	 *
	 * Usage:
	 * ```
	 * const MyCrate = new Crate({ MyNum: 10 })
	 * const MyAwesomeValue = MyCrate.Get("MyNum")
	 *       ^ Number
	 * ```
	 */
	Get<U extends keyof T>(Key: U): T[U];
	Get<U extends keyof T>(Key?: unknown) {
		if (Key !== undefined) {
			return this.State[Key as U];
		} else {
			return DeepCopy(this.State);
		}
	}

	/**
	 * Open the crate and permit writes.
	 */
	Open() {
		this.CrateOpen = true;
	}

	/**
	 * Close the crate and prevent writes.
	 *
	 * ```
	 * const MyCrate = new Crate({Name: "Paul"})
	 *
	 * MyCrate.Close()
	 *
	 * MyCrate.Update("Name", "John") // Silently ignored
	 * ```
	 */
	Close() {
		this.CrateOpen = false;
	}

	/**
	 * Return's true if the crate is open, and false if it's closed.
	 */
	IsOpen() {
		return this.CrateOpen;
	}

	/**
	 * Reset a key to it's default state.
	 */
	Reset<U extends keyof T>(Key: U): void {
		this.Update(Key, this.InitialState[Key]);
	}

	/**
	 * Return the crate to it's default state.
	 */
	Restore() {
		this.State = DeepCopy(this.InitialState);
	}

	/**
	 * Purge the events within the crate.
	 */
	Destroy() {
		this.Connections.forEach((C) => C.Disconnect());
		this.UpdateBind?.Destroy();
	}
}
