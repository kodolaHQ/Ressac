// Les articles du widget : les meilleurs du tri (bloc `top`), avec le résumé de Gemma quand il y en a un (bloc
// `resumes`, repris par URL). Mêmes champs qu'avant les workflows : titre, url, source, p, resume.
export default async ({ top, resumes }) => {
  const parUrl = new Map((resumes ?? []).filter((a) => typeof a?.resume === "string" && a.resume).map((a) => [a.url, a.resume]));
  const articles = (top ?? []).map(({ titre, url, source, p }) => {
    const resume = parUrl.get(url);
    return resume ? { titre, url, source, p, resume } : { titre, url, source, p };
  });
  return { articles };
};
