// sortie: what it receives becomes the workflow's output (for `vers: "widget"`, the widget's data).
export default {
  parElement: "non",
  async executer({ entree }) {
    return { sortie: entree };
  },
};
