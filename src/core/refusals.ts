/** How each refusal family the DM meets most often opens its reply. */
const LEADS = {
  /** An id or name this campaign does not have. */
  unknown_id: 'No',
  /** The call belongs to another moment: no active encounter, no character yet, no region map. */
  wrong_mode: 'Not now:',
  /** A field the call needs was not passed. */
  missing_field: 'Missing',
  /** The use, slot or charge the call would spend is gone. */
  resource_spent: 'Already spent:',
  /** The rules forbid the call as asked. */
  rules: 'Against the rules:',
} as const;

export type RefusalCode = keyof typeof LEADS;

/** The Error a tool throws to refuse a call, reading `<lead> <detail>. <retry>`; the SDK hands its message to the DM. */
export function refusal(code: RefusalCode, detail: string, retry: string): Error {
  return new Error(`${LEADS[code]} ${detail}. ${retry}`);
}
