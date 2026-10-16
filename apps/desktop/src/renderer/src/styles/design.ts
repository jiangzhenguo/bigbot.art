/**
 * BigBotArt 设计系统样式 — Apple HIG + Liquid Glass
 * 从 colors_and_type.css 提取为 React 可用的样式对象
 */

/** 走 CSS 变量,随 prefers-color-scheme / nativeTheme 翻转(禁止再写死十六进制) */
export const colors = {
  bg: 'var(--bg)',
  surface: 'var(--surface)',
  surfaceWarm: 'var(--surface-warm)',
  fg: 'var(--fg)',
  fg2: 'var(--fg-2)',
  muted: 'var(--muted)',
  meta: 'var(--meta)',
  border: 'var(--border)',
  borderSoft: 'var(--border-soft)',
  accent: 'var(--accent)',
  accentOn: 'var(--accent-on)',
  accentHover: 'var(--accent-hover)',
  accentActive: 'var(--accent-active)',
  success: 'var(--success)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
} as const;

export const fonts = {
  display: '"SF Pro Display", "SF Pro Icons", "Helvetica Neue", Helvetica, Arial, sans-serif',
  body: '"SF Pro Text", "SF Pro Icons", "Helvetica Neue", Helvetica, Arial, sans-serif',
  mono: '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, Monaco, Consolas, monospace',
} as const;

export const spacing = {
  1: '4px',
  2: '8px',
  3: '12px',
  4: '16px',
  5: '20px',
  6: '24px',
  8: '32px',
  12: '48px',
} as const;

export const radius = {
  sm: '8px',
  md: '12px',
  lg: '18px',
  pill: '980px',
} as const;

export const textSizes = {
  xs: '12px',
  sm: '14px',
  base: '17px',
  lg: '21px',
  xl: '28px',
  '2xl': '40px',
  '3xl': '56px',
  '4xl': '80px',
} as const;

export const motion = {
  fast: '150ms',
  base: '220ms',
  easeStandard: 'cubic-bezier(0.28, 0, 0.22, 1)',
} as const;

// ─── 常用样式对象 ────────────────────────────────────────────────────────────

export const baseStyles = {
  app: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
    background: colors.bg,
    color: colors.fg,
    fontFamily: fonts.body,
    fontSize: textSizes.sm,
    lineHeight: 1.47,
    WebkitFontSmoothing: 'antialiased',
  },
  topbar: {
    height: '48px',
    flexShrink: 0,
    borderBottom: `1px solid ${colors.borderSoft}`,
    display: 'flex',
    alignItems: 'center',
    gap: spacing[2],
    padding: `0 ${spacing[3]}`,
    background: colors.surfaceWarm,
  },
  work: {
    flex: 1,
    display: 'flex',
    minHeight: 0,
  },
} as const;

// ─── 组件样式 ────────────────────────────────────────────────────────────────

export const btnStyles = {
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    padding: `${spacing[2]} ${spacing[4]}`,
    borderRadius: radius.md,
    fontSize: textSizes.sm,
    fontWeight: 500,
    lineHeight: 1.25,
    border: '1px solid transparent',
    whiteSpace: 'nowrap' as const,
    transition: `background ${motion.fast} ${motion.easeStandard}, border-color ${motion.fast}, transform 60ms`,
    cursor: 'pointer',
  },
  primary: {
    background: colors.accent,
    color: colors.accentOn,
  },
  secondary: {
    background: colors.bg,
    borderColor: colors.border,
    color: colors.fg,
  },
  ghost: {
    color: colors.fg2,
  },
  danger: {
    background: colors.danger,
    color: colors.accentOn,
  },
} as const;

export const chipStyles = {
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing[1],
    padding: `${spacing[1]} ${spacing[3]}`,
    border: `1px solid ${colors.border}`,
    borderRadius: radius.pill,
    fontSize: textSizes.xs,
    color: colors.fg,
    background: colors.bg,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    userSelect: 'none' as const,
    transition: `border-color ${motion.fast}, background ${motion.fast}, color ${motion.fast}`,
  },
  on: {
    background: colors.fg,
    borderColor: colors.fg,
    color: colors.bg,
  },
} as const;

export const cardStyles = {
  base: {
    background: colors.bg,
    border: `1px solid ${colors.borderSoft}`,
    borderRadius: radius.lg,
  },
  hover: {
    borderColor: colors.border,
    boxShadow: 'var(--elev-raised)',
    transform: 'translateY(-2px)',
  },
} as const;

export const popStyles = {
  base: {
    position: 'absolute' as const,
    zIndex: 80,
    minWidth: '230px',
    background: colors.bg,
    border: `1px solid ${colors.borderSoft}`,
    borderRadius: radius.md,
    boxShadow: 'var(--elev-raised)',
    padding: spacing[1],
    display: 'none',
  },
  open: {
    display: 'block',
  },
} as const;

export const sidebarStyles = {
  base: {
    width: '236px',
    flexShrink: 0,
    background: colors.surface,
    borderRight: `1px solid ${colors.borderSoft}`,
    display: 'flex',
    flexDirection: 'column' as const,
    minHeight: 0,
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing[2],
    padding: `${spacing[4]} ${spacing[4]} ${spacing[3]}`,
    fontFamily: fonts.display,
    fontSize: textSizes.base,
    fontWeight: 600,
    letterSpacing: '-0.015em',
  },
  nav: {
    padding: `0 ${spacing[2]}`,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: spacing[1],
    overflow: 'auto',
  },
  navLabel: {
    padding: `${spacing[3]} ${spacing[2]} ${spacing[1]}`,
    fontSize: textSizes.xs,
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase' as const,
    color: colors.muted,
  },
  link: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing[2],
    padding: `${spacing[1]} ${spacing[2]}`,
    borderRadius: radius.sm,
    fontSize: textSizes.sm,
    color: colors.fg2,
    transition: `background ${motion.fast}`,
    textDecoration: 'none',
  },
  linkOn: {
    background: `color-mix(in oklab, ${colors.fg} 8%, transparent)`,
    color: colors.fg,
    fontWeight: 600,
  },
} as const;

// ─── 辅助函数 ────────────────────────────────────────────────────────────────

export function combineStyles(...styles: (React.CSSProperties | undefined)[]): React.CSSProperties {
  return Object.assign({}, ...styles.filter(Boolean));
}

export function glassStyles(level: 'sm' | 'md' | 'lg' = 'md') {
  const map = {
    sm: {
      background: 'var(--glass-bg)',
      backdropFilter: 'var(--glass-blur-sm)',
      WebkitBackdropFilter: 'var(--glass-blur-sm)',
      boxShadow: 'var(--glass-spec), var(--glass-shadow)',
    },
    md: {
      background: 'var(--glass-bg)',
      backdropFilter: 'var(--glass-blur)',
      WebkitBackdropFilter: 'var(--glass-blur)',
      boxShadow: 'var(--glass-shadow), var(--glass-spec)',
    },
    lg: {
      background: 'var(--glass-bg-strong)',
      backdropFilter: 'var(--glass-blur)',
      WebkitBackdropFilter: 'var(--glass-blur)',
      boxShadow: 'var(--glass-shadow-lg), var(--glass-spec)',
    },
  };
  return map[level];
}