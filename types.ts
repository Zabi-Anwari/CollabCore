
// Added Collaborator interface to fix missing export errors
export interface Collaborator {
  id: string;
  name: string;
  color: string;
}

export interface CRDTAttributes {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontSize?: string;
  fontFamily?: string;
}

export interface CRDTChar {
  value: string;
  position: FractionalIndex;
  siteId: string;
  attributes?: CRDTAttributes;
}

export type FractionalIndex = number[];

export type CRDTOperation = 
  | { type: 'insert'; char: CRDTChar; siteId: string }
  | { type: 'delete'; position: FractionalIndex; siteId: string }
  | { type: 'format'; position: FractionalIndex; charSiteId: string; attributes: Partial<CRDTAttributes>; siteId: string }
  | { type: 'cursor'; siteId: string; cursor: number; name: string; color: string }
  | { type: 'request-sync'; siteId: string }
  | { type: 'sync-response'; siteId: string; state: CRDTChar[] };
