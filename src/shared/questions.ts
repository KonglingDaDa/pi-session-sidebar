/** Native Jev HTTP question shapes used by timeline judgments. */
type Noul = { type: "noul"; instructions: unknown; criteria: { true: string; false: string } };
export type Score = { type: "score"; instructions: unknown; criteria: unknown[] };
export type Question = Noul | Score;
export const noul = (instructions: unknown, yes: string, no: string): Noul => ({
  type: "noul", instructions, criteria: { true: yes, false: no },
});
