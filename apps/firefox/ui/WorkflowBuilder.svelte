<script lang="ts">
  import type { Owner } from "../../../packages/noyau/src/index";
  import Constructeur from "../ui/constructeur/Constructeur.svelte";
  import { suivreDisparitions } from "../ui/constructeur/edition.svelte";
  import { api } from "../ui/etat.svelte";
  import { homeListForBuilder } from "./builder";

  // The builder page. Its own suivreDisparitions(api.accueil) comes second and is ignored (first call wins): the
  // Firefox home read also carries the theme.
  let { cible }: { cible: Owner } = $props();
  suivreDisparitions(homeListForBuilder(api));
</script>

<Constructeur {cible} />
