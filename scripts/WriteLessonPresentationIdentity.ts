import { resolve } from 'node:path';
import { writeLessonPresentationIdentity } from './LessonPresentationIdentity.js';

await writeLessonPresentationIdentity(resolve('.'));
