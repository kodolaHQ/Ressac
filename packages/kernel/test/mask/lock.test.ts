import { expect, test } from "vitest";
import { ConversationLock } from "../../src/mask/lock.js";

const MAIL = "https://mail.example.test";
const BANK = "https://bank.example.test";

test("unlocked, every destination is allowed, a missing one too", () => {
  const lock = new ConversationLock();
  expect(lock.locked()).toBe(false);
  expect(lock.allows(BANK)).toBe(true);
  expect(lock.allows(null)).toBe(true);
});

test("one reveal allows only its origins, never a missing destination", () => {
  const lock = new ConversationLock();
  lock.reveal("⟨code-aaaaaaaa⟩", [MAIL]);
  expect(lock.locked()).toBe(true);
  expect(lock.allows(MAIL)).toBe(true);
  expect(lock.allows(BANK)).toBe(false);
  expect(lock.allows(null)).toBe(false);
});

test("the spec's example: a code from the webmail, then an IBAN from the bank, leaves no origin allowed", () => {
  const lock = new ConversationLock();
  lock.reveal("⟨code-aaaaaaaa⟩", [MAIL]);
  lock.reveal("⟨iban-bbbbbbbb⟩", [BANK]);
  for (const o of [MAIL, BANK, "https://other.test", null]) expect(lock.allows(o)).toBe(false);
  expect(lock.revealed()).toEqual([
    { label: "⟨code-aaaaaaaa⟩", origins: [MAIL] },
    { label: "⟨iban-bbbbbbbb⟩", origins: [BANK] },
  ]);
});

test("a value without origin, or a conversation born locked, allows nothing", () => {
  const noOrigin = new ConversationLock();
  noOrigin.reveal("⟨tel-cccccccc⟩", null);
  expect(noOrigin.allows(MAIL)).toBe(false);
  const born = new ConversationLock();
  born.bornLocked();
  expect(born.locked()).toBe(true);
  expect(born.revealed()).toEqual([]);
  expect(born.allows(MAIL)).toBe(false);
});

test("the origins are copied: a value seen later on another origin does not widen the lock", () => {
  const lock = new ConversationLock();
  const origins = [MAIL];
  lock.reveal("⟨code-aaaaaaaa⟩", origins);
  origins.push(BANK);
  (lock.revealed()[0]!.origins as string[]).push(BANK);
  expect(lock.allows(BANK)).toBe(false);
});

test("allowedOrigins: null unlocked; else the origins allows() accepts, [] when none or born locked", () => {
  const lock = new ConversationLock();
  expect(lock.allowedOrigins()).toBeNull();
  lock.reveal("⟨code-a⟩", [MAIL, BANK]);
  expect(lock.allowedOrigins()).toEqual([MAIL, BANK]);
  lock.reveal("⟨iban-b⟩", [BANK]);
  expect(lock.allowedOrigins()).toEqual([BANK]);
  for (const o of lock.allowedOrigins()!) expect(lock.allows(o)).toBe(true);
  lock.reveal("⟨tel-c⟩", null);
  expect(lock.allowedOrigins()).toEqual([]);
  const born = new ConversationLock();
  born.bornLocked();
  expect(born.allowedOrigins()).toEqual([]);
});
