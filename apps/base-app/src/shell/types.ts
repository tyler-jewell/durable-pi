// The shape of one entry in the nav rail. A .ts module, so consumers can import the type without loading a component.
export interface NavItem {
  id: string;
  label: string;
  kind?: string;
}
