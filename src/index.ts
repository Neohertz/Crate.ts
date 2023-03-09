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
	private UpdateBind: BindableEvent;
	private Connections: RBXScriptConnection[] = [];
	private InitialState: T;
	private MiddlewareMap = new Map<unknown, unknown>();
	private LockedKeys = new Set<keyof T>();
	private IsVerbose = false;

	private Log(Msg: string, Verbose = true) {
		if (!Verbose || this.IsVerbose) warn(`${this.IsVerbose ? "[VRB] " : ""}[Crate] ${Msg}`);
	}

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
		Closed && this.Lock();
	}

	// Internal method to execute middleware.
	private ExecuteMiddleware<U extends keyof T>(Key: U, New: T[U], Old: T[U]): T[U] {
		const MW_EXEC_TIME = tick();

		const Method = this.MiddlewareMap.get(Key) as MiddlewareType<T, U>;
		const Result = Method !== undefined ? Method(New, Old) : New;

		if (tick() - MW_EXEC_TIME > 0.2)
			this.Log("WARN: Yeilding is prohibited within middleware to prevent unexpected behavior.", false);

		return Result;
	}

	Verbose() {
		this.IsVerbose = true;
		return this;
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
	 * MyCrate.OnChange("MyNum", (New, Old) => {
	 *  print(New, Old) // 5 & 10
	 * })
	 * ```
	 */
	OnChange<U extends keyof T>(Key: U, Callback: (NewData: T[U], OldData: T[U]) => void): RBXScriptConnection;
	/**
	 * Listen for changes on the entire crate.
	 *
	 * If the crate is closed, this event will not fire.
	 *
	 * Usage:
	 * ```
	 * const MyCrate = new Crate({MyNum: 10})
	 *
	 * MyCrate.OnChange((NewStore, OldStore) => {
	 *  print(New.MyNum, Old.MyNum) // 5 & 10
	 * })
	 * ```
	 */
	//FIXME: Make onchange with no key return the key changed, new data, and old data.
	OnChange<U extends keyof T>(Callback: (NewData: T, OldData: T) => void): RBXScriptConnection;
	OnChange<U extends keyof T>(Key: U, Callback = Key as unknown): RBXScriptConnection {
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
	 * const Old = MyCrate.Update("MyNum", 5)
	 * print(Old) // 10
	 * ```
	 */
	Update<U extends keyof T>(Key: U, Value: T[U]): T[U];
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
	Update(Dispatch: Partial<T>): void;
	Update<U extends keyof T>(Key: unknown, Value?: unknown) {
		if (typeIs(Key, "table")) {
			for (const [K, V] of pairs(Key)) {
				this.Update(K as U, V as T[U]);
			}
		} else {
			if (this.LockedKeys.has(Key as U)) {
				this.Log(`Attepted to set (${tostring(Key)} => ${tostring(Value)}), but the key is locked.`);
				return;
			}

			const Old = this.State[Key as U];
			const Result = this.ExecuteMiddleware(Key as U, Value as T[U], Old);

			if (Result === Old) return Old;

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
		if (this.LockedKeys.has(Key as U)) return this.State[Key];

		if (!typeIs(this.State[Key], "number")) {
			this.Log(`WARN: Attempt to increment '${tostring(Key)}', a non-integer value.`, true);
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
	 * Unlock all keys within the crate and permit writes.
	 */
	Unlock(): void;
	/**
	 * Unlock a single key to permit writes.
	 */
	Unlock<U extends keyof T>(Key: U): void;
	Unlock<U extends keyof T>(Key?: U) {
		if (Key !== undefined) {
			this.LockedKeys.delete(Key);
		} else {
			for (const [Key, _] of pairs(this.State as object)) {
				this.LockedKeys.delete(Key as U);
			}
		}
	}

	/**
	 * Lock all keys within the crate and prevent writes.
	 */
	Lock(): void;
	/**
	 * Lock a single key to prevent writes.
	 */
	Lock<U extends keyof T>(Key: U): void;
	Lock<U extends keyof T>(Key?: U) {
		if (Key !== undefined) {
			this.LockedKeys.add(Key);
		} else {
			for (const [Key, _] of pairs(this.State as object)) {
				this.LockedKeys.add(Key as U);
			}
		}
	}

	/**
	 * Return's true if the crate is locked, and false if it's not.
	 */
	/**
	 * Iterates through the store to check if any keys are unlocked.
	 *
	 * If there is an unlocked key, the crate is not fully locked.
	 */
	IsLocked(): void;
	/**
	 * Check if a specific key is locked.
	 */
	IsLocked<U extends keyof T>(Key: U): void;
	IsLocked<U extends keyof T>(Key?: U) {
		if (Key !== undefined) {
			return this.LockedKeys.has(Key as U);
		} else {
			for (const [Key, _] of pairs(this.State as object)) {
				if (!this.LockedKeys.has(Key as U)) return false;
			}

			return true;
		}
	}

	/**
	 * Reset a key to it's default state.
	 */
	Reset<U extends keyof T>(Key: U): this {
		this.Update(Key, this.InitialState[Key]);

		return this;
	}

	/**
	 * Return the crate to it's default state.
	 */
	Restore(): this {
		this.State = DeepCopy(this.InitialState);
		return this;
	}

	/**
	 * Snapshot the current state as the new default.
	 *
	 * If `Restore()` or `Reset()` are called, it will revert to this value.
	 */
	Snapshot(): this {
		this.InitialState = DeepCopy(this.State);

		return this;
	}

	/**
	 * Overwrite the internal memory to a new state. Must retain the type of the original data.
	 *
	 * Keeps the original state in tact. To overwrite this state, use `Snapshot()`:
	 * ```ts
	 * HealthCrate.Overwrite({
	 * 	Health: 10
	 * }).Snapshot()
	 * ```
	 */
	Overwrite(State: T): this {
		this.State = State;
		return this;
	}

	/**
	 * Purge the events within the crate.
	 */
	Destroy() {
		this.Connections.forEach((C) => C.Disconnect());
		this.UpdateBind?.Destroy();
	}
}
