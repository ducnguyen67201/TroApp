import type { ClassroomHome } from '#contracts/Classroom.js';
import type { OrganizationSummary } from '#contracts/Organizations.js';

/** Resolves older classroom responses against the signed-in account's organization directory. */
export function resolveClassOrganizationNames(
  home: ClassroomHome,
  organizations: readonly Pick<OrganizationSummary, 'id' | 'name'>[],
): ClassroomHome {
  const names = new Map(home.teachingOrganizations?.map(({ id, name }) => [id, name]));
  for (const organization of organizations) {
    names.set(organization.id, organization.name);
  }
  return {
    ...home,
    classes: home.classes.map((entry) => {
      const name =
        entry.organizationName ??
        (entry.organizationId ? names.get(entry.organizationId) : undefined);
      return name ? { ...entry, organizationName: name } : entry;
    }),
  };
}
