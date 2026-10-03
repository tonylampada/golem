// What the shell shows a person, by their account roles. The server holds the same rules
// (brain routes, the app's `authorize`); hiding here only keeps the menu honest.

type Roles = { user: { roles: string[] } | null } | undefined
export type AppScreen = { id: string; label: string; icon?: string; roles?: string[] }
export type BrainSetting = boolean | { roles: string[] } | undefined

const holds = (me: Roles, roles: string[]) => Boolean(me?.user?.roles.some((role) => roles.includes(role)))

/** The app's screens this person may open: one without `roles` is everyone's, one with them needs one of them. */
export const visibleScreens = (screens: AppScreen[], me: Roles): AppScreen[] =>
  screens.filter((screen) => !screen.roles || holds(me, screen.roles))

/** Whether the Brain item and reader are this person's: `brain: true` is everyone's, `{ roles }` needs one of them. */
export const brainVisible = (brain: BrainSetting, me: Roles): boolean =>
  brain === true || (Boolean(brain) && typeof brain === 'object' && holds(me, brain.roles))
