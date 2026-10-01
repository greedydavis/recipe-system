import type { VersionLine } from '../data/types';

/** 依「分組」把相鄰的用料分成一段一段（版本頁與標準卡共用） */
export function groupLines(lines: VersionLine[]): Array<[string, VersionLine[]]> {
  const groups: Array<[string, VersionLine[]]> = [];
  for (const l of lines) {
    const last = groups[groups.length - 1];
    if (last && last[0] === l.group_label) last[1].push(l);
    else groups.push([l.group_label, [l]]);
  }
  return groups;
}
