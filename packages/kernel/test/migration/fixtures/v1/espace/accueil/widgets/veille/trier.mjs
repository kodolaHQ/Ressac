export default async function (e, webaios) { const p = await webaios.lirePage(e[0].url); return e.map((x) => ({ ...x, titre: x.titre })); }
