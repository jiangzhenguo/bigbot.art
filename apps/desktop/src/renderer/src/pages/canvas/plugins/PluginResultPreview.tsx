import React from 'react';
import { SafeImage } from '../../../components/SafeImage';
import { AudioPlayer, basenameOf, outputUrlOf, VideoThumb } from '../media';

export type PluginResultMedia = 'image' | 'video' | 'audio' | 'document';

export interface PluginResultPreviewProps {
  path: string;
  media: PluginResultMedia;
  title: string;
}

/** 插件主产物预览：与内置节点共用本地产物 URL 和媒体组件。 */
export function PluginResultPreview({ path, media, title }: PluginResultPreviewProps) {
  if (!path) return null;
  const src = outputUrlOf(path);
  const name = basenameOf(path);

  if (media === 'image') {
    return (
      <div className="nthumb fit" data-od-id="plugin-result-image" data-media={media}>
        <SafeImage src={src} alt={`${title} · 图片产物`} />
      </div>
    );
  }
  if (media === 'video') {
    return (
      <div data-od-id="plugin-result-video" data-media={media}>
        <VideoThumb src={src} badge={name} />
      </div>
    );
  }
  if (media === 'audio') {
    return (
      <div data-od-id="plugin-result-audio" data-media={media}>
        <AudioPlayer src={src} name={name} compact />
      </div>
    );
  }
  return (
    <div
      className="nthumb"
      data-od-id="plugin-result-document"
      data-media="document"
      role="group"
      aria-label={`${title} · 文档产物`}
      style={{
        minHeight: 72,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: 6,
        padding: 10,
        border: '1px solid var(--border-soft)',
        background: 'var(--surface-warm)',
        color: 'var(--muted)',
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 22 }}>📄</span>
      <span className="mono" style={{ fontSize: 10, overflowWrap: 'anywhere' }}>{name}</span>
    </div>
  );
}
