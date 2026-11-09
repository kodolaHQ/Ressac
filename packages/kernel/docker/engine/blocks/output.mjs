// output: what it receives becomes the workflow's output (for `to: "widget"`, the widget's data).
export default {
  perItem: "no",
  async run({ input }) {
    return { output: input };
  },
};
