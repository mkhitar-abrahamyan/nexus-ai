import { ImageValidationError } from './errors.js';

/** Throws unless both sides are positive integers. `option` names the field, for the message. */
export function validateDimensions(dimensions: { width: number; height: number }, option: string): void {
  if (!Number.isInteger(dimensions.width) || dimensions.width < 1) {
    throw new ImageValidationError(`${option}.width must be a positive integer`);
  }
  if (!Number.isInteger(dimensions.height) || dimensions.height < 1) {
    throw new ImageValidationError(`${option}.height must be a positive integer`);
  }
}
