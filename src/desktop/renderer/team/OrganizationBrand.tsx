import { useState, type ReactElement } from 'react';
import { Menu, UnstyledButton } from '@mantine/core';
import type { OrganizationSummary } from '#contracts/Organizations.js';
import { TroIcon } from '../TroIcon.js';
import { useLocale } from '../localization/UseLocale.js';
import { teamMessages } from './TeamMessages.js';

interface OrganizationBrandProps {
  accountId: string;
  organizations: readonly OrganizationSummary[];
  onEditLogo?: ((organizationId: string) => void) | undefined;
}

function BrandMark({
  organization,
}: {
  organization: OrganizationSummary | undefined;
}): ReactElement {
  const [failedLogo, setFailedLogo] = useState<string | null>(null);
  const logo = organization?.logoDataUrl;
  return logo && logo !== failedLogo ? (
    <span className="organization-brand-mark">
      <img
        src={logo}
        width={32}
        height={32}
        alt=""
        aria-hidden="true"
        onError={() => {
          setFailedLogo(logo);
        }}
      />
      <span className="organization-tro-badge">
        <TroIcon size={12} />
      </span>
    </span>
  ) : (
    <TroIcon size={32} />
  );
}

/** Branding uses actual memberships only; choosing a logo never changes classroom authority. */
export function OrganizationBrand({
  accountId,
  organizations,
  onEditLogo,
}: OrganizationBrandProps): ReactElement {
  const { locale } = useLocale();
  const messages = teamMessages[locale];
  const [choice, setChoice] = useState<{ accountId: string; organizationId: string } | null>(null);
  const joined = organizations.filter(
    (organization) => organization.role !== null && organization.isNameSet !== false,
  );
  const selected =
    joined.find(
      (organization) =>
        choice?.accountId === accountId && organization.id === choice.organizationId,
    ) ?? joined[0];
  const label = selected ? `${selected.name} · Tro` : 'Tro';
  if (joined.length < 2 && selected?.isOwner && onEditLogo) {
    return (
      <UnstyledButton
        className="organization-brand"
        aria-label={`${messages.editLogo}: ${label}`}
        title={label}
        onClick={() => {
          onEditLogo(selected.id);
        }}
      >
        <BrandMark key={`${accountId}:${selected.id}`} organization={selected} />
      </UnstyledButton>
    );
  }
  if (joined.length < 2) {
    return (
      <span className="organization-brand" role="img" aria-label={label} title={label}>
        <BrandMark key={`${accountId}:${selected?.id ?? 'personal'}`} organization={selected} />
      </span>
    );
  }
  return (
    <Menu position="right-start" withinPortal>
      <Menu.Target>
        <UnstyledButton
          className="organization-brand"
          aria-label={`${messages.chooseOrganization}: ${label}`}
          title={label}
        >
          <BrandMark key={`${accountId}:${selected?.id ?? 'personal'}`} organization={selected} />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{messages.chooseOrganization}</Menu.Label>
        {joined.map((organization) => (
          <Menu.Item
            key={organization.id}
            aria-current={organization.id === selected?.id ? 'true' : undefined}
            onClick={() => {
              setChoice({ accountId, organizationId: organization.id });
            }}
          >
            {organization.name}
          </Menu.Item>
        ))}
        {selected?.isOwner && onEditLogo && (
          <>
            <Menu.Divider />
            <Menu.Item
              onClick={() => {
                onEditLogo(selected.id);
              }}
            >
              {messages.editLogo}
            </Menu.Item>
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
