/**
 * Wrap the type of a circularly imported injectable:
 *
 *   constructor(@Inject(forwardRef(() => B)) private readonly b: Ref<B>) {}
 *
 * Under ESM, decorator metadata references the class eagerly and a circular import
 * crashes with "Cannot access B before initialization", even with forwardRef.
 * The alias makes the emitted metadata `Object`; forwardRef supplies the token.
 * Better still: remove the cycle.
 */
export type Ref<T> = T;
