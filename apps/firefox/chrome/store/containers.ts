import type { ProfileId } from "../../shared/model";
import { DEFAULT_PROFILE } from "../../shared/model";

const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");

/** Internal identity name of a login profile's container. */
// Stored format kept across the rename to Ressac: the key of every container in the profile's containers.json.
export const internalName = (id: ProfileId) => `userContextIdInternal.webaios-${id}`;

/**
 * userContextId of a login profile: 0 for the default one, else a private container (invisible to add-ons) created on first use.
 * Not a policy identity: Firefox's enterprise policies (SitePolicies) wipe every policy identity they do not list.
 * shortcut: pushes onto ContextualIdentityService._identities, no public API makes a private non-policy identity; recheck after a Firefox upgrade.
 */
export function containerFor(profile: ProfileId): number {
  if (profile === DEFAULT_PROFILE) return 0;
  const name = internalName(profile);
  const found = ContextualIdentityService.getPrivateIdentity(name);
  if (found) return found.userContextId;
  ContextualIdentityService.ensureDataReady();
  const userContextId = ++ContextualIdentityService._lastUserContextId;
  ContextualIdentityService._identities.push({ userContextId, public: false, name });
  ContextualIdentityService.saveSoon();
  return userContextId;
}

/** userContextId of a login profile's container if it exists (0 for the default one), else null: never creates one. */
export function existingContainer(profile: ProfileId): number | null {
  if (profile === DEFAULT_PROFILE) return 0;
  return ContextualIdentityService.getPrivateIdentity(internalName(profile))?.userContextId ?? null;
}

/** Removes the container of a login profile and wipes its cookies and storage, as removePolicyIdentity does. */
export function removeContainer(profile: ProfileId): void {
  const { _identities: list } = ContextualIdentityService;
  const index = list.findIndex((i: { public: boolean; name: string }) => !i.public && i.name === internalName(profile));
  if (index === -1) return;
  Services.clearData.deleteDataFromOriginAttributesPattern({ userContextId: list[index].userContextId });
  list.splice(index, 1);
  ContextualIdentityService.saveSoon();
}

/** userContextId of site app `id`'s private container (`userContextIdInternal.webaios-site-<id>`), created on first use. */
export const siteContainer = (id: string): number => containerFor(`site-${id}`);

/** Is this a private container whose internal name starts with `ressac-<prefix>`? */
function hasPrefix(userContextId: number, prefix: string): boolean {
  if (!userContextId) return false;
  ContextualIdentityService.ensureDataReady();
  const name = internalName(prefix);
  return ContextualIdentityService._identities.some((i: { public: boolean; name: string; userContextId: number }) => !i.public && i.userContextId === userContextId && i.name.startsWith(name));
}

/** Is this the container of a site app (open or not)? The request guard refuses every page of one whose app is closed. */
export const isSiteContainer = (userContextId: number): boolean => hasPrefix(userContextId, "site-");

/** Wipes a container's cookies and storage (waited for, as invisible.ts's clearContainer), then drops its identity. */
async function wipe(profile: ProfileId): Promise<void> {
  const userContextId = existingContainer(profile);
  if (userContextId === null) return;
  await new Promise<void>((ok) => Services.clearData.deleteDataFromOriginAttributesPattern({ userContextId }, { onDataDeleted: () => ok() }));
  removeContainer(profile);
}

/** Wipes site app `id`'s cookies and storage, then drops its identity. */
export const removeSiteContainer = (id: string): Promise<void> => wipe(`site-${id}`);

/** userContextId of agent app `folder`'s private container (`userContextIdInternal.webaios-app-<folder>`), created on first use. */
export const appContainer = (folder: string): number => containerFor(`app-${folder}`);

/** Is this the container of an agent app (running or not)? The request guard refuses every page of one whose app is not open. */
export const isAppContainer = (userContextId: number): boolean => hasPrefix(userContextId, "app-");

/** « Supprimer »: agent app `folder`'s cookies and storage are wiped, then its identity dropped. */
export const removeAppContainer = (folder: string): Promise<void> => wipe(`app-${folder}`);
