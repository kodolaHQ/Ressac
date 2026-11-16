// The widget's articles: the best of the sort (block `top`), with the AI's summary when there is one (block
// `resumes`, taken by URL). Fields: title, url, source, score, summary.
export default async ({ top, resumes }) => {
  const byUrl = new Map((resumes ?? []).filter((a) => typeof a?.summary === "string" && a.summary).map((a) => [a.url, a.summary]));
  const articles = (top ?? []).map(({ title, url, source, score }) => {
    const summary = byUrl.get(url);
    return summary ? { title, url, source, score, summary } : { title, url, source, score };
  });
  return { articles };
};
