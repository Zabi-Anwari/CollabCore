
import { CRDTChar, FractionalIndex, CRDTAttributes } from '../types';

export class LSEQ {
  private chars: CRDTChar[] = [];
  private siteId: string;

  constructor(siteId: string) {
    this.siteId = siteId;
  }

  get text(): string {
    // Optimized for large documents: join is significantly faster than string concatenation in a loop
    return this.chars.map(c => c.value).join('');
  }

  get state(): CRDTChar[] {
    // Return a deep copy of the state to prevent cross-site mutation during sync
    return this.chars.map(c => ({
      ...c,
      position: [...c.position],
      attributes: c.attributes ? { ...c.attributes } : undefined
    }));
  }

  get rawChars(): CRDTChar[] {
    return this.chars;
  }

  loadState(newState: CRDTChar[]) {
    // Ensure we are working with a fresh copy
    this.chars = newState ? newState.map(c => ({
      ...c,
      position: [...c.position],
      attributes: c.attributes ? { ...c.attributes } : undefined
    })) : [];
    // Sort to ensure binary search validity even if remote state was unsorted
    this.chars.sort((a, b) => this.comparePositions(a, b));
  }

  private generateIdentifierBetween(pos1: FractionalIndex, pos2: FractionalIndex): FractionalIndex {
    const newPos: FractionalIndex = [];
    let i = 0;
    const BASE = 1024;

    while (true) {
      const v1 = pos1[i] ?? 0;
      const v2 = pos2[i] ?? BASE;
      const diff = v2 - v1;

      if (diff > 1) {
        // Choose deterministic midpoint to preserve insertion order
        const midpoint = v1 + Math.ceil(diff / 2);
        newPos.push(midpoint);
        return newPos;
      }

      // No space at this level. Copy the prefix and continue deeper.
      newPos.push(v1);
      i++;

      // As a safety valve, if we go too deep create fresh space.
      if (i > 128) {
        newPos.push(v1 + 1);
        return newPos;
      }
    }
  }

  // Efficient local bulk delete
  localBatchDelete(startIndex: number, endIndex: number): { char: CRDTChar, op: { position: FractionalIndex; siteId: string } }[] {
    const results: { char: CRDTChar, op: { position: FractionalIndex; siteId: string } }[] = [];
    
    // Validate bounds
    if (startIndex < 0 || endIndex > this.chars.length || startIndex >= endIndex) {
        return [];
    }
    
    // Get the chars to be deleted (copy them)
    // We iterate start to end because the chars are contiguous in the array
    for (let i = startIndex; i < endIndex; i++) {
        const char = this.chars[i];
        results.push({ 
            char: char, 
            op: { position: char.position, siteId: char.siteId } 
        });
    }
    
    // Perform single splice
    this.chars.splice(startIndex, endIndex - startIndex);
    
    return results;
  }

  localInsert(index: number, value: string, attributes?: CRDTAttributes): CRDTChar {
    const prev = this.chars[index - 1]?.position ?? [0];
    const next = this.chars[index]?.position ?? [100];
    
    const char: CRDTChar = {
      value,
      position: this.generateIdentifierBetween(prev, next),
      siteId: this.siteId,
      attributes: attributes ? { ...attributes } : undefined
    };

    this.remoteInsert(char);
    return char;
  }

  localDelete(index: number): { position: FractionalIndex; siteId: string } | null {
    const char = this.chars[index];
    if (!char) return null;
    
    const op = { position: char.position, siteId: char.siteId };
    this.remoteDelete(char.position, char.siteId);
    return op;
  }

  localFormat(index: number, attributes: Partial<CRDTAttributes>): { position: FractionalIndex; charSiteId: string } | null {
    const char = this.chars[index];
    if (!char) return null;
    
    char.attributes = { ...(char.attributes || {}), ...attributes };
    return { position: char.position, charSiteId: char.siteId };
  }

  remoteInsert(char: CRDTChar) {
    let low = 0;
    let high = this.chars.length;

    while (low < high) {
      const mid = (low + high) >>> 1;
      const cmp = this.comparePositions(this.chars[mid], char);
      if (cmp < 0) low = mid + 1;
      else if (cmp > 0) high = mid;
      else return; // Duplicate found, ignore
    }
    
    this.chars.splice(low, 0, char);
    return low;
  }

  // Optimized for bulk deletions
  batchRemoteDelete(ops: { position: FractionalIndex; siteId: string }[]): number {
    if (ops.length === 0) return 0;
    
    // Convert deletions to a Set of unique keys for O(1) checking
    const deletionSet = new Set<string>();
    for (let i = 0; i < ops.length; i++) {
    // Simple string key format: "siteId:pos"
    // Using string interpolation on arrays calls .toString() which joins with commas
    // We must ensure consistent formatting. 
    // JSON.stringify is safer for array comparison than .toString() to avoid ambiguity or potential inconsistencies across environments if Prototype is messed with,
    // though .toString() is usually fine for number arrays.
    // Let's stick to a manual join to be 100% sure of the format.
    deletionSet.add(`${ops[i].siteId}:${ops[i].position.join(',')}`);
    }
    
    // Filter out deleted chars in one pass - O(N)
    let writeIdx = 0;
    let deletedCount = 0;
    for (let i = 0; i < this.chars.length; i++) {
        const char = this.chars[i];
        // Must match the key generation exactly
        if (!deletionSet.has(`${char.siteId}:${char.position.join(',')}`)) {
            if (writeIdx !== i) {
                this.chars[writeIdx] = char;
            }
            writeIdx++;
        } else {
            deletedCount++;
        }
    }
    
    // Truncate the array
    if (writeIdx < this.chars.length) {
        this.chars.length = writeIdx;
    }
    return deletedCount;
  }

  remoteDelete(position: FractionalIndex, siteId: string): number {
    // Binary search for the character - O(log N)
    let low = 0;
    let high = this.chars.length - 1;

    while (low <= high) {
      const mid = (low + high) >>> 1;
      const midChar = this.chars[mid];
      
      const posCmp = this.compareArrays(midChar.position, position);
      let cmp = 0;
      if (posCmp !== 0) {
          cmp = posCmp;
      } else {
          cmp = midChar.siteId.localeCompare(siteId);
      }

      if (cmp < 0) {
          low = mid + 1;
      } else if (cmp > 0) {
          high = mid - 1;
      } else {
        // Found match - splice is O(N)
        this.chars.splice(mid, 1);
        return mid;
      }
    }
    
    // Fallback: Linear search if binary search fails (e.g. slight sort inconsistency)
    // This ensures consistency at the cost of performance in rare error cases
    const idx = this.chars.findIndex(c => 
        this.compareArrays(c.position, position) === 0 && c.siteId === siteId
    );
    if (idx !== -1) {
        this.chars.splice(idx, 1);
        return idx;
    }
    return -1;
  }

  remoteFormat(position: FractionalIndex, charSiteId: string, attributes: Partial<CRDTAttributes>) {
    const char = this.chars.find(c => 
      this.compareArrays(c.position, position) === 0 && c.siteId === charSiteId
    );
    if (char) {
      char.attributes = { ...(char.attributes || {}), ...attributes };
    }
  }

  private comparePositions(a: CRDTChar, b: CRDTChar): number {
    const cmp = this.compareArrays(a.position, b.position);
    if (cmp !== 0) return cmp;
    return a.siteId.localeCompare(b.siteId);
  }

  private compareArrays(a: number[], b: number[]): number {
    if (!Array.isArray(a) || !Array.isArray(b)) return 0;
    const len1 = a.length;
    const len2 = b.length;
    const minLen = Math.min(len1, len2);
    
    for (let i = 0; i < minLen; i++) {
        const val1 = a[i];
        const val2 = b[i];
        if (val1 < val2) return -1;
        if (val1 > val2) return 1;
    }
    
    // Standard lexicographical: shorter prefix comes first
    if (len1 < len2) return -1;
    if (len1 > len2) return 1;
    
    return 0;
  }
}
