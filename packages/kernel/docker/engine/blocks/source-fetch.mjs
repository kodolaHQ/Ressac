// source.fetch: public GET (text or JSON) through today's `fetch` call.

async function fetchUrl({ params, fill, webaios }) {
  const { text: url } = fill(params.url, { url: true });
  return webaios.fetch(url, { format: params.format ?? "text" });
}

export default {
  perItem: "option",
  async run(ctx) {
    return { output: await fetchUrl(ctx) };
  },
  processItem: fetchUrl,
};
