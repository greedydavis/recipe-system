import imageCompression from 'browser-image-compression';
import { Camera, ImageOff, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../app/auth';
import { rpc, useAction } from '../data/api';
import type { Photo } from '../data/types';
import { Button, cx, useToast } from './ui';

export type PhotoTarget = { version_id: string } | { step_id: string } | { tasting_item_id: string };

function targetPrefix(target: PhotoTarget): string {
  if ('version_id' in target) return `versions/${target.version_id}`;
  if ('step_id' in target) return `steps/${target.step_id}`;
  return `tastings/${target.tasting_item_id}`;
}

export function PhotoThumb({ path, alt, className }: { path: string; alt: string; className?: string }) {
  const { backend } = useAuth();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    backend
      ?.photoUrl(path)
      .then((u) => alive && setUrl(u))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [backend, path]);

  if (failed) {
    return (
      <div className={cx('flex items-center justify-center bg-stone-100 text-stone-400', className)}>
        <ImageOff className="size-6" aria-label="照片無法載入" />
      </div>
    );
  }
  if (!url) return <div className={cx('animate-pulse bg-stone-100', className)} />;
  return <img src={url} alt={alt} className={cx('object-cover', className)} loading="lazy" />;
}

export function PhotoStrip({
  photos,
  target,
  canAdd,
  canDelete,
  emptyText = '還沒有照片',
  large,
}: {
  photos: Photo[];
  target: PhotoTarget;
  canAdd: boolean;
  canDelete: boolean;
  emptyText?: string;
  large?: boolean;
}) {
  const { backend } = useAuth();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [viewing, setViewing] = useState<Photo | null>(null);

  const upload = useAction(async (files: File[]) => {
    if (!backend) return;
    for (const file of files) {
      const compressed = await imageCompression(file, {
        maxWidthOrHeight: 1600,
        maxSizeMB: 0.5,
        fileType: 'image/webp',
        initialQuality: 0.8,
        useWebWorker: true,
      });
      const path = `${targetPrefix(target)}/${crypto.randomUUID()}.webp`;
      await backend.uploadPhoto(path, compressed);
      await rpc('add_photo', { p: { ...target, storage_path: path } });
    }
  });

  const remove = useAction(async (photo: Photo) => {
    const res = await rpc<{ storage_path: string; still_referenced: boolean }>('delete_photo', { p_id: photo.id });
    if (!res.still_referenced) await backend?.removePhotoFile(res.storage_path);
  });

  const size = large ? 'size-32' : 'size-20';

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {photos.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setViewing(p)}
            className={cx('overflow-hidden rounded-xl ring-1 ring-line', size)}
            aria-label="放大照片"
          >
            <PhotoThumb path={p.storage_path} alt={p.caption || '照片'} className="size-full" />
          </button>
        ))}
        {canAdd && (
          <button
            type="button"
            onClick={() => input.current?.click()}
            disabled={upload.isPending}
            className={cx(
              'no-print flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-line text-sm text-muted hover:bg-brand-50',
              size,
            )}
          >
            <Camera className="size-6" aria-hidden />
            {upload.isPending ? '上傳中…' : '加照片'}
          </button>
        )}
        {photos.length === 0 && !canAdd && <p className="text-sm text-muted">{emptyText}</p>}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length === 0) return;
          upload.mutate(files, {
            onSuccess: () => toast(`已上傳 ${files.length} 張照片`),
            onError: (err) => toast(err.message, 'danger'),
          });
        }}
      />
      {viewing && (
        <div className="no-print fixed inset-0 z-50 flex flex-col bg-black/90" role="dialog" aria-modal="true">
          <div className="flex justify-end gap-2 p-3">
            {canDelete && (
              <Button
                variant="danger"
                small
                loading={remove.isPending}
                onClick={() => {
                  if (!confirm('確定刪除這張照片？')) return;
                  remove.mutate(viewing, {
                    onSuccess: () => {
                      setViewing(null);
                      toast('已刪除照片');
                    },
                    onError: (err) => toast(err.message, 'danger'),
                  });
                }}
              >
                <Trash2 className="size-4" />
                刪除
              </Button>
            )}
            <Button variant="secondary" small onClick={() => setViewing(null)}>
              關閉
            </Button>
          </div>
          <div className="flex flex-1 items-center justify-center p-3">
            <PhotoThumb path={viewing.storage_path} alt="放大的照片" className="max-h-full max-w-full object-contain" />
          </div>
        </div>
      )}
    </div>
  );
}
