import { featureCase } from './irtranp-metadata.mjs';

const numberFor = feature => String(featureCase(feature.caseID).number + (feature.copyIndex ?? 0)).padStart(2, '0');
export const UPLOAD_ACKNOWLEDGED = 'Upload acknowledged and session closed. Verify saved photos in the read-back steps. Save the ZIP.';
export const TWO_UPLOADS_ACKNOWLEDGED = 'Both uploads acknowledged. Read photo 10 and photo 11 back in the next two steps. Save the ZIP.';
export const UPLOAD_EVIDENCE_NOTE = 'Transfer acknowledgements are shown here. Saved photos are verified by reading them back.';

export function reportResultKey(report) {
  if (report.test === 'sender' && report.verdict === 'passed') return 'Upload acknowledged';
  return report.featureEvidence?.outcome ?? report.verdict;
}

export function featureSendButtonText(caseID, t) {
  if ((featureCase(caseID).copies ?? 1) > 1) return t('Send photos 10 and 11');
  if (featureCase(caseID).recordedInput) return t('Send only photo {number}').replace('{number}', numberFor({ caseID }));
  return t('Send test image');
}

export function featureStepTitle(step, t) {
  const title = t(featureCase(step.feature.caseID).title);
  return title + ' · ' + (step.feature.role === 'read' ?
    t('Read back photo {number}').replace('{number}', numberFor(step.feature)) : t('Write'));
}

export function featureInstructions(feature, t) {
  if (feature.role === 'read') return t('On the watch: OTHERS SEND. Select photo {number}. Send one photo in this step.').replace('{number}', numberFor(feature));
  if (feature.caseID === 'multiple-wince211') return t('On the watch: OTHERS RECEIVE. Photos 10 and 11 / 07FB use one connection at 9600 bit/s. Transport: Windows CE 2.11. Activate reception after starting the test here. Keep the watch facing the adapter until the test ends.');
  if (feature.caseID === 'multiple-csi') return t('On the watch: OTHERS RECEIVE. Both photos use one connection at 9600 bit/s. SCEP packets follow CSI: the watch limit (2048 bytes in the saved reply), instead of 512 bytes.');
  if (featureCase(feature.caseID).recordedInput) return t('On the watch: OTHERS RECEIVE. Only photo {number} from the failed two-photo attempt will be sent, unchanged, in its own connection.').replace('{number}', numberFor(feature));
  if (feature.caseID === 'multiple') return t('On the watch: OTHERS RECEIVE. The computer sends photos 10 and 11 automatically in one connection. Keep the watch in receive mode until the test ends.');
  return t('The watch will RECEIVE the numbered image. Prepare USB before activating reception.');
}

export function missingPhotoInstructions(feature, t) {
  if (feature?.role !== 'read') return '';
  return t('If photo {number} is missing, release USB if prepared, enter the missing photo number as the skip reason, and choose Skip step.').replace('{number}', numberFor(feature));
}
