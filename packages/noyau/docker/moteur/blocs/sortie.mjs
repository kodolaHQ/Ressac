// sortie : ce qu'il reçoit devient la sortie du workflow (pour `vers: "widget"`, les données du widget).
export default {
  parElement: "non",
  async executer({ entree }) {
    return { sortie: entree };
  },
};
