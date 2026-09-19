/** Plain values shared by the UI and the server. No imports from src/server. */
export type Note = { id: string; version: number; title: string; body?: string; archived?: boolean; locked?: boolean }
