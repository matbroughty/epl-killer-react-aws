import { Amplify } from 'aws-amplify';
// @ts-ignore
import awsExports from './aws-exports';

try {
  Amplify.configure(awsExports);
} catch {
  // Ignore if not yet generated
}
