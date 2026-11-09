<script lang="ts">
  import type { Owner } from "../../../packages/kernel/src/index";
  import Builder from "./builder/Builder.svelte";
  import { followDisappearances } from "./builder/edit.svelte";
  import { api } from "./state.svelte";
  import { homeListForBuilder } from "./builder";

  // The builder page. Its own followDisappearances(api.accueil) comes second and is ignored (first call wins): the
  // Firefox home read also carries the theme.
  let { target: target }: { target: Owner } = $props();
  followDisappearances(homeListForBuilder(api));
</script>

<Builder target={target} />
