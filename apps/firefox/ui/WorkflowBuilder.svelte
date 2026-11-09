<script lang="ts">
  import type { Owner } from "../../../packages/noyau/src/index";
  import Builder from "../ui/constructeur/Constructeur.svelte";
  import { followDisappearances } from "../ui/constructeur/edition.svelte";
  import { api } from "../ui/etat.svelte";
  import { homeListForBuilder } from "./builder";

  // The builder page. Its own suivreDisparitions(api.accueil) comes second and is ignored (first call wins): the
  // Firefox home read also carries the theme.
  let { cible: target }: { cible: Owner } = $props();
  followDisappearances(homeListForBuilder(api));
</script>

<Builder cible={target} />
