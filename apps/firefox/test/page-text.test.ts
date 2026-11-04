import { expect, it } from "vitest";
import { composeText, isYoutubeVideo } from "../shared/page-text";

it("isYoutubeVideo: only YouTube /watch pages", () => {
  expect(isYoutubeVideo("https://www.youtube.com/watch?v=abc")).toBe(true);
  expect(isYoutubeVideo("https://youtube.com/watch?v=abc")).toBe(true);
  expect(isYoutubeVideo("https://m.youtube.com/watch?v=abc")).toBe(true);
  expect(isYoutubeVideo("https://www.youtube.com/")).toBe(false);
  expect(isYoutubeVideo("https://exemple.fr/watch?v=abc")).toBe(false);
  expect(isYoutubeVideo("not a url")).toBe(false);
});

it("composeText: description then body, empty parts omitted", () => {
  expect(composeText({ description: "Summary", corps: "Page body" })).toBe("Summary\n\nPage body");
  expect(composeText({ description: "  ", corps: "Body" })).toBe("Body");
  expect(composeText({ corps: "" })).toBe("");
});

it("composeText: a YouTube video gives title, channel and description, without the rest of the page", () => {
  expect(composeText({ video: { titre: "My video", chaine: "My channel", description: "What it is about" }, corps: "comments…" })).toBe(
    "My video\n\nMy channel\n\nWhat it is about",
  );
});
