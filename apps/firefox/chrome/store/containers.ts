import type { IdProfil } from "../../../navigateur/src/commun/modele";
import { PROFIL_DEFAUT } from "../../../navigateur/src/commun/modele";

const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");

const nameOf = (id: IdProfil): string => `webaios-${id}`;

/** userContextId of a login profile: 0 for the default one, else a container named after it (created on first use). */
export function containerFor(profile: IdProfil): number {
  if (profile === PROFIL_DEFAUT) return 0;
  const name = nameOf(profile);
  const found = ContextualIdentityService.getPublicIdentities().find((i: { name: string }) => i.name === name);
  return (found ?? ContextualIdentityService.create(name, "fence", "blue")).userContextId;
}

/** Removes the container of a login profile and wipes its cookies and storage. */
export async function removeContainer(profile: IdProfil): Promise<void> {
  const found = ContextualIdentityService.getPublicIdentities().find((i: { name: string }) => i.name === nameOf(profile));
  if (!found) return;
  ContextualIdentityService.remove(found.userContextId);
  await Services.clearData.deleteDataFromOriginAttributesPattern({ userContextId: found.userContextId });
}
