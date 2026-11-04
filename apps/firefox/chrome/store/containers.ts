import type { IdProfil } from "../../../navigateur/src/commun/modele";
import { PROFIL_DEFAUT } from "../../../navigateur/src/commun/modele";

const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");

/** Internal identity name of a login profile's container. */
export const internalName = (id: IdProfil) => `userContextIdInternal.webaios-${id}`;

/** userContextId of a login profile: 0 for the default one, else an internal container (invisible to add-ons) created on first use. */
export function containerFor(profile: IdProfil): number {
  if (profile === PROFIL_DEFAUT) return 0;
  const name = internalName(profile);
  return (ContextualIdentityService.getPrivateIdentity(name) ?? ContextualIdentityService.createForPolicy(name)).userContextId;
}

/** Removes the container of a login profile. removePolicyIdentity also wipes the container's cookies and storage. */
export function removeContainer(profile: IdProfil): void {
  const found = ContextualIdentityService.getPrivateIdentity(internalName(profile));
  if (found) ContextualIdentityService.removePolicyIdentity(found.userContextId);
}

/**
 * Public `webaios-<id>` identities left by older builds become internal in place (same userContextId, so cookies and storage stay;
 * spike S4). shortcut: edits ContextualIdentityService._identities, no public API does this; recheck after a Firefox upgrade.
 */
export function migrateContainers(): void {
  ContextualIdentityService.ensureDataReady();
  let changed = false;
  for (const i of ContextualIdentityService._identities) {
    if (!i.public || !i.name?.startsWith("webaios-")) continue;
    i.public = false;
    i.name = i.policyId = `userContextIdInternal.${i.name}`;
    i.policy = true;
    delete i.icon;
    delete i.color;
    delete i.l10nId;
    changed = true;
  }
  if (changed) ContextualIdentityService.saveSoon();
}
