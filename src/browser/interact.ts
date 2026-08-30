import { abArgs } from '../utils/exec.js';

/**
 * Click an element by its ref (e.g., @e3).
 */
export function click(ref: string, sessionName?: string): void {
  abArgs(['click', ref], { timeoutMs: 10000, session: sessionName });
}

/**
 * Fill a form field by its ref.
 */
export function fill(ref: string, value: string, sessionName?: string): void {
  abArgs(['fill', ref, value], { timeoutMs: 10000, session: sessionName });
}

/**
 * Type text (keyboard input, not targeting a specific element).
 */
export function type(text: string, sessionName?: string): void {
  abArgs(['type', text], { timeoutMs: 10000, session: sessionName });
}

/**
 * Press a key (e.g., Enter, Tab, Escape).
 */
export function press(key: string, sessionName?: string): void {
  abArgs(['press', key], { timeoutMs: 5000, session: sessionName });
}

/**
 * Scroll the page in a direction.
 */
export function scroll(direction: 'up' | 'down' = 'down', amount = 3, sessionName?: string): void {
  abArgs(['scroll', direction, String(amount)], { timeoutMs: 5000, session: sessionName });
}
