// The widget's articles: the best of the sort (block `top`), with Gemma's summary when there is one (block
// `resumes`, taken by URL). Same fields as before the workflows: titre, url, source, p, resume.
export default async ({ top, resumes }) => {
  const parUrl = new Map((resumes ?? []).filter((a) => typeof a?.resume === "string" && a.resume).map((a) => [a.url, a.resume]));
  const articles = (top ?? []).map(({ titre, url, source, p }) => {
    const resume = parUrl.get(url);
    return resume ? { titre, url, source, p, resume } : { titre, url, source, p };
  });
  return { articles };
};
