import { expect, test, vi } from "vitest";
import { keepTicks, rememberSite } from "../../chrome/agent/remember";
import type { TabInfo } from "../../chrome/shims/kernel";

// « Retenir ce site » (task 13b), chrome's side of a written seal.
const tabs: TabInfo[] = [
  { id: "mine", title: "", url: "https://a.example/", space: "s", profile: "perso", agentReached: false },
  { id: "reached", title: "", url: "https://a.example/", space: "s", profile: "perso", agentReached: true },
  { id: "work", title: "", url: "https://a.example/", space: "s", profile: "travail", agentReached: false },
];
const R = { profile: "perso", id: "0000000000000001", window: "w1" };

function setup(saved: boolean) {
  const addOrigin = vi.fn(async () => saved);
  const notice = vi.fn(async () => {});
  return { addOrigin, notice, remembered: rememberSite({ listed: () => tabs, addOrigin, notice }) };
}

test("a tab the agent reached, another profile's tab or a tab gone: nothing written, the notice told", async () => {
  const { addOrigin, notice, remembered } = setup(true);
  for (const tab of ["reached", "work", "gone"]) await remembered(tab, "https://a.example", R);
  expect(addOrigin).not.toHaveBeenCalled();
  expect(notice.mock.calls).toEqual([["w1"], ["w1"], ["w1"]]);
});

test("the user's tab: the site goes to the entry; a failed save tells the card's window, a good one says nothing", async () => {
  let s = setup(false);
  await s.remembered("mine", "https://a.example", R);
  expect(s.addOrigin.mock.calls).toEqual([["perso", R.id, "https://a.example"]]);
  expect(s.notice.mock.calls).toEqual([["w1"]]);
  s = setup(true);
  await s.remembered("mine", "https://a.example", R);
  expect(s.addOrigin).toHaveBeenCalledTimes(1);
  expect(s.notice).not.toHaveBeenCalled();
});

test("the kernel's answer has no ticks: each goes onto its seal with the card's window", () => {
  const remember = vi.fn();
  const answer = { yes: true, picks: ["r1"], remember: [{ seal: "s0", profile: "perso", id: R.id }] };
  expect(keepTicks(answer, "w1", remember)).toEqual({ yes: true, picks: ["r1"] });
  expect(remember.mock.calls).toEqual([["s0", R]]);
  const plain: { yes: boolean; remember?: never[] } = { yes: true };
  expect(keepTicks(plain, "w1", remember)).toEqual({ yes: true });
  expect(remember).toHaveBeenCalledTimes(1);
});
