import React from 'react';

export const ICON_DOC = (
  <>
    <path d="M6 2h9l5 5v15H6Z" />
    <path d="M14 2v6h6M9 13h8M9 17h5" />
  </>
);
export const ICON_DOC_S = (
  <>
    <path d="M6 2h9l5 5v15H6Z" />
    <path d="M14 2v6h6" />
  </>
);
export const ICON_IMAGE = (
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="1.8" />
    <path d="m4.5 18 5-5 3.5 3.5 3-3 3.5 3.5" />
  </>
);
export const ICON_EDIT = (
  <>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </>
);
export const ICON_UPSCALE = <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />;
export const ICON_CROP = (
  <>
    <path d="M6 2v16h16" />
    <path d="M18 22V6H2" />
    <path d="m15 9-6 6M15 15H9V9" />
  </>
);
export const ICON_STITCH = (
  <>
    <rect x="2.5" y="7" width="8.5" height="10" rx="1.5" />
    <rect x="13" y="7" width="8.5" height="10" rx="1.5" />
    <path d="M11 12h2" />
  </>
);
export const ICON_SPLIT = (
  <>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M4 12h16M12 4v16" strokeDasharray="3 2" />
  </>
);
export const ICON_SHOT = (
  <>
    <rect x="2.5" y="5" width="19" height="14" rx="2" />
    <path d="m10 9.5 5 2.5-5 2.5Z" />
  </>
);
export const ICON_DIRECTOR = (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.5 8.5-2 5-5 2 2-5Z" />
  </>
);
export const ICON_AUDIO = (
  <>
    <path d="M9 18V6l12-3v12" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="18.5" cy="15" r="2.5" />
  </>
);
export const ICON_TIMELINE = (
  <>
    <rect x="2.5" y="5" width="19" height="14" rx="2" />
    <path d="M7 5v14M17 5v14" />
  </>
);
export const ICON_COMFY = (
  <>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
    <path d="M10 6.5h7a3.5 3.5 0 0 1 3.5 3.5v4" />
  </>
);
export const ICON_ASSET = (
  <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z" />
);
export const ICON_WF_INPUT = (
  <>
    <path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3" />
    <path d="m16 8 4 4-4 4M20 12H9" />
  </>
);
export const ICON_WF_OUTPUT = (
  <>
    <path d="M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3" />
    <path d="m8 8-4 4 4 4M4 12h11" />
  </>
);

export const PALETTE_ICONS: Record<string, React.ReactNode> = {
  doc: ICON_DOC,
  asset: ICON_ASSET,
  image: ICON_IMAGE,
  edit: ICON_EDIT,
  upscale: ICON_UPSCALE,
  crop: ICON_CROP,
  stitch: ICON_STITCH,
  split: ICON_SPLIT,
  shot: ICON_SHOT,
  director: ICON_DIRECTOR,
  audio: ICON_AUDIO,
  timeline: ICON_TIMELINE,
  comfy: ICON_COMFY,
  'wf-input': ICON_WF_INPUT,
  'wf-output': ICON_WF_OUTPUT,
};

export const TYPE_ICON: Record<string, React.ReactNode> = {
  document: ICON_DOC_S,
  asset: ICON_ASSET,
  'image-gen': ICON_IMAGE,
  'image-edit': ICON_EDIT,
  'image-upscale': ICON_UPSCALE,
  'image-crop': ICON_CROP,
  'image-stitch': ICON_STITCH,
  'image-split': ICON_SPLIT,
  shot: ICON_SHOT,
  director: ICON_DIRECTOR,
  'audio-ref': ICON_AUDIO,
  timeline: ICON_TIMELINE,
  'workflow-input': ICON_WF_INPUT,
  'workflow-output': ICON_WF_OUTPUT,
  plain: ICON_DOC_S,
};
