<script lang="ts">
  import type { Owner } from "../../../packages/kernel/src/index";
  import Builder from "./builder/Builder.svelte";
  import { followDisappearances } from "./builder/edition.svelte";
  import { api } from "./state.svelte";
  import { homeListForBuilder } from "./builder";

  // The builder page. Its own suivreDisparitions(api.accueil) comes second and is ignored (first call wins): the
  // Firefox home read also carries the theme.
  let { cible: target }: { cible: Owner } = $props();
  followDisappearances(homeListForBuilder(api));
</script>

<Builder cible={target} />
