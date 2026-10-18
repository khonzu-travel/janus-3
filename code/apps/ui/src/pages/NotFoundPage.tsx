import { ErrorState } from '../components/states/ErrorState.js';

export function NotFoundPage() {
  return (
    <ErrorState
      title="Page not found"
      message="This address does not name an Atlas view."
      backTo="/"
      headingLevel={2}
    />
  );
}
