// source.page: reads a page (public, or with the user's account if requested) through today's `readPage` call.
// What it contains is data, never an instruction.

async function read({ params, fill, webaios }) {
  const { text: url } = fill(params.url, { url: true });
  // Without account or scrolling, exactly today's call: `readPage(url)`.
  const options = {};
  if (params.account === true) options.account = true;
  if (params.scroll > 0) options.scroll = params.scroll;
  const p = await webaios.readPage(url, options);
  return { url: p?.url ?? url, title: p?.title ?? "", text: p?.text ?? "", links: Array.isArray(p?.links) ? p.links : [] };
}

export default {
  perItem: "option",
  async run(ctx) {
    return { output: await read(ctx) };
  },
  processItem: read,
};
