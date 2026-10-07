/**
 * Version ranges, as an adapter declares the releases of `nexus-ai-pro` it works with. A small,
 * dependency-free subset of npm's ranges: comparators joined by spaces must all hold, alternatives
 * joined by `||` need one to hold, and `>=`, `>`, `<=`, `<`, `=`, `^`, `~`, `x`, and `*` mean what
 * they mean in npm.
 */

type Version = [number, number, number];

/** A version as three numbers. A prerelease or build tag is ignored. `undefined` for anything else. */
export function parseVersion(version: string): Version | undefined {
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Whether `version` satisfies `range`, such as `>=2.4.0 <3` or `^2.4.0 || ^3.0.0`. */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  return range.split('||').some((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean);
    return comparators.length === 0 || comparators.every((comparator) => holds(parsed, comparator));
  });
}

function holds(version: Version, comparator: string): boolean {
  const match = /^(>=|<=|>|<|=|\^|~)?v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?/.exec(comparator);
  if (!match) throw new RangeError(`"${comparator}" is not a version range`);
  const operator = match[1] ?? '';
  const parts = [match[2], match[3], match[4]];
  // How many leading parts are numbers: `2.x` fixes one, `2.4` two, `2.4.1` three.
  const fixed = parts.findIndex((part) => part === undefined || /^[xX*]$/.test(part));
  const known = fixed === -1 ? 3 : fixed;
  const base = parts.map((part, index) => (index < known ? Number(part) : 0)) as Version;
  if (known === 0) return operator === '' || operator === '=' || operator === '>=' || operator === '<=';

  switch (operator) {
    case '>=':
      return compare(version, base) >= 0;
    case '>':
      return known === 3 ? compare(version, base) > 0 : compare(version, bump(base, known - 1)) >= 0;
    case '<=':
      return known === 3 ? compare(version, base) <= 0 : compare(version, bump(base, known - 1)) < 0;
    case '<':
      return compare(version, base) < 0;
    case '^': {
      // The first non-zero part is the one that may not change.
      const pinned = base[0] > 0 || known === 1 ? 0 : base[1] > 0 || known === 2 ? 1 : 2;
      return compare(version, base) >= 0 && compare(version, bump(base, pinned)) < 0;
    }
    case '~':
      return compare(version, base) >= 0 && compare(version, bump(base, known >= 2 ? 1 : 0)) < 0;
    default:
      // A bare or `=` version: exact when complete, the whole span of its wildcard otherwise.
      return known === 3
        ? compare(version, base) === 0
        : compare(version, base) >= 0 && compare(version, bump(base, known - 1)) < 0;
  }
}

/** The next version up at `part`, with the parts after it reset. */
function bump(version: Version, part: number): Version {
  return version.map((value, index) => (index < part ? value : index === part ? value + 1 : 0)) as Version;
}

function compare(left: Version, right: Version): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return (left[index] as number) - (right[index] as number);
  }
  return 0;
}
