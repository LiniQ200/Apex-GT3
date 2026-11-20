/** Registration of the GT3 kit drawings and paint charts on the donor.
 * The drawings were laid out on a 2.04 × 4.63 m reference car with a 75 mm
 * sill. These ratios move attachment stations, never the imported vehicle. */
export class KitFit {
  readonly across: number;
  readonly along: number;
  readonly sillOffset: number;

  constructor(
    readonly width: number,
    readonly length: number,
    readonly clearance: number,
  ) {
    this.across = width / 2.04;
    this.along = length / 4.63;
    this.sillOffset = clearance - 0.075 * this.along;
  }

  height(drawingY: number) {
    return this.sillOffset + drawingY * this.along;
  }
}
