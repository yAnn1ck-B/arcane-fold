import { manaTypes, steps, zones } from "./types";
import type { Action } from "./types";

type Field = (value: unknown) => boolean;
const string: Field = (value) => typeof value === "string";
const id: Field = (value) => typeof value === "string" && value.length > 0;
const integer: Field = (value) => Number.isSafeInteger(value);
const oneOf =
  (values: readonly unknown[]): Field =>
  (value) =>
    values.includes(value);
const seat = oneOf([0, 1]);
const ids: Field = (value) => Array.isArray(value) && value.every(id);
const maybe =
  (field: Field): Field =>
  (value) =>
    value === undefined || field(value);
const zone = oneOf(zones);
const stackMove = { entry: id, zone: maybe(zone) };

// Saved commands are data, including when they came from a previous app run.
// Enumerate allowed fields so an unknown seat or malformed option can't silently
// turn into a different action during replay.
const schemas: Record<Action["type"], Record<string, Field>> = {
  finishDecision: { seat },
  draw: { seat, count: maybe(integer) },
  shuffle: { seat, order: ids },
  mulligan: { seat, order: ids },
  keep: { seat, bottom: ids },
  move: { id, zone, position: maybe(oneOf(["top", "bottom"])) },
  tap: { id },
  tapMana: { id, mana: oneOf(manaTypes), count: integer },
  flip: { id },
  faceDown: { id },
  reveal: { id },
  control: { id },
  untapAll: { seat },
  clearMana: { seat },
  combat: { id, mark: oneOf(["attacking", "blocking", null]) },
  attach: { id, to: (value) => value === null || id(value) },
  counter: { id, name: string, delta: integer },
  playerCounter: { seat, name: string, delta: integer },
  token: { seat, name: string },
  life: { seat, delta: integer },
  mana: { seat, mana: oneOf(manaTypes), delta: integer },
  cast: { id, targets: maybe(string) },
  ability: { id, label: string, targets: maybe(string) },
  copy: { entry: id, seat, targets: maybe(string) },
  targets: { entry: id, targets: string },
  reorderStack: { entry: id, direction: oneOf(["up", "down"]) },
  resolve: stackMove,
  counterSpell: stackMove,
  nextStep: {},
  nextTurn: {},
  setStep: {
    step: (value) =>
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0 &&
      value < steps.length,
  },
};

export function validAction(input: unknown): input is Action {
  if (typeof input !== "object" || !input || Array.isArray(input)) return false;
  const data = input as Record<string, unknown>;
  if (typeof data.type !== "string" || !Object.hasOwn(schemas, data.type))
    return false;
  const fields = schemas[data.type as Action["type"]];
  return (
    Object.keys(data).every(
      (key) => key === "type" || Object.hasOwn(fields, key),
    ) && Object.entries(fields).every(([key, validate]) => validate(data[key]))
  );
}
