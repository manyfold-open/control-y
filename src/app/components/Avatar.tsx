/**
 * A person's face, or their initials when there is no face to show.
 *
 * The portrait is found by convention rather than stored: `public/people/<id>.svg`
 * if a file is there, nothing if it is not. No column, no migration, and no
 * seed change, which is what makes it work on a workspace that is already
 * running: `ensureSeed` skips a database that has been seeded once, so a photo
 * written into seed.ts would never reach one.
 *
 * A missing file is therefore the ordinary case rather than a fault. `onError`
 * falls back to the initials chip that stood here before, so somebody added to
 * the directory tomorrow still gets a mark, and so does everyone if the assets
 * fail to deploy.
 */

import { useState } from 'react';
import { initials } from '../lib';

/** Where a person's portrait would be. Null with no id to name it after. */
export const photoSrc = (id: string | undefined): string | null =>
  id ? `/people/${id}.svg` : null;

/** `self` is the ink ground: the whole mark without a portrait, and covered by
 *  one when there is, since these carry their own light ground. */
export const avatarClass = (isSelf: boolean, large: boolean): string =>
  ['avatar', isSelf && 'self', large && 'large'].filter(Boolean).join(' ');

interface AvatarProps {
  /** The person's id. The photo, if there is one, is named after it. */
  id?: string;
  /** Shown as initials when there is no photo, and never as the image's alt:
   *  every caller prints the name next to this, so a face is decorative. */
  name: string;
  isSelf?: boolean;
  /** The roster identifies people for a living, so there it gets 40px. */
  large?: boolean;
}

export default function Avatar({ id, name, isSelf = false, large = false }: AvatarProps) {
  /* The src that failed, not a boolean: an avatar whose person changes under it,
     which is what reassigning an issue does, then retries on its own. */
  const [broken, setBroken] = useState<string | null>(null);
  const src = photoSrc(id);

  return (
    <span className={avatarClass(isSelf, large)}>
      {src && src !== broken ? (
        <img src={src} alt="" onError={() => setBroken(src)} />
      ) : (
        initials(name)
      )}
    </span>
  );
}
