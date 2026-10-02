/** Framework-free colors shared by the native window and renderer theme. */
export const TroPalette = {
  CREAM: '#FFFCF2',
  GRAY: '#CCC5B9',
  CHARCOAL: '#403D39',
  BLACK: '#252422',
  ORANGE: '#EB5E28',
} as const;

/** Native overlays require a concrete color rather than a CSS color-mix value. */
export const DesktopWindowAppearance = {
  BACKGROUND: '#F7F3E9',
  FOREGROUND: TroPalette.BLACK,
  TITLE_BAR_HEIGHT: 52,
} as const;
