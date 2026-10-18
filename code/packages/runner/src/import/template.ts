import { isVariableName } from '../model.js';
import { toVariableName } from './names.js';

/**
 * Converts Postman and Bruno template text to Janus templates. `{{name}}` stays as written when the name fits the
 * variable grammar; dynamic variables become Janus tokens; anything else that
 * would not load is escaped or renamed, with a note.
 */

/** `postman` and `bruno` text is a template in its tool; `literal` is recorded traffic (Charles, HAR). */
export type TemplateDialect = 'postman' | 'bruno' | 'literal';

export type Note = (message: string) => void;

/**
 * Postman's dynamic variables with a `faker.*` equivalent.
 * Each target is a faker v10 generator that takes no arguments and is
 * deterministic for a seed (checked by core's `checkFakerPath` in the tests).
 */
export const FAKER_TABLE: Readonly<Record<string, string>> = Object.freeze({
  randomFirstName: 'person.firstName',
  randomLastName: 'person.lastName',
  randomFullName: 'person.fullName',
  randomNamePrefix: 'person.prefix',
  randomNameSuffix: 'person.suffix',
  randomJobTitle: 'person.jobTitle',
  randomJobArea: 'person.jobArea',
  randomJobType: 'person.jobType',
  randomJobDescriptor: 'person.jobDescriptor',
  randomEmail: 'internet.email',
  randomExampleEmail: 'internet.exampleEmail',
  randomUserName: 'internet.username',
  randomUrl: 'internet.url',
  randomDomainName: 'internet.domainName',
  randomDomainSuffix: 'internet.domainSuffix',
  randomDomainWord: 'internet.domainWord',
  randomIP: 'internet.ipv4',
  randomIPV6: 'internet.ipv6',
  randomMACAddress: 'internet.mac',
  randomPassword: 'internet.password',
  randomUserAgent: 'internet.userAgent',
  randomProtocol: 'internet.protocol',
  randomPhoneNumber: 'phone.number',
  randomCity: 'location.city',
  randomStreetName: 'location.street',
  randomStreetAddress: 'location.streetAddress',
  randomCountry: 'location.country',
  randomCountryCode: 'location.countryCode',
  randomCompanyName: 'company.name',
  randomCatchPhrase: 'company.catchPhrase',
  randomBs: 'company.buzzPhrase',
  randomProductName: 'commerce.productName',
  randomProduct: 'commerce.product',
  randomProductAdjective: 'commerce.productAdjective',
  randomProductMaterial: 'commerce.productMaterial',
  randomPrice: 'commerce.price',
  randomDepartment: 'commerce.department',
  randomColor: 'color.human',
  randomHexColor: 'color.rgb',
  randomAlphaNumeric: 'string.alphanumeric',
  randomWord: 'lorem.word',
  randomWords: 'lorem.words',
  randomLoremWord: 'lorem.word',
  randomLoremWords: 'lorem.words',
  randomLoremSentence: 'lorem.sentence',
  randomLoremSentences: 'lorem.sentences',
  randomLoremParagraph: 'lorem.paragraph',
  randomLoremParagraphs: 'lorem.paragraphs',
  randomLoremSlug: 'lorem.slug',
  randomLoremLines: 'lorem.lines',
  randomLoremText: 'lorem.text',
  randomCurrencyCode: 'finance.currencyCode',
  randomCurrencyName: 'finance.currencyName',
  randomCurrencySymbol: 'finance.currencySymbol',
  randomBankAccount: 'finance.accountNumber',
  randomBankAccountName: 'finance.accountName',
  randomBankAccountIban: 'finance.iban',
  randomBankAccountBic: 'finance.bic',
  randomBitcoin: 'finance.bitcoinAddress',
  randomTransactionType: 'finance.transactionType',
  randomFileName: 'system.fileName',
  randomFileExt: 'system.fileExt',
  randomFileType: 'system.fileType',
  randomFilePath: 'system.filePath',
  randomDirectoryPath: 'system.directoryPath',
  randomMimeType: 'system.mimeType',
  randomSemver: 'system.semver',
  randomCommonFileName: 'system.commonFileName',
  randomCommonFileExt: 'system.commonFileExt',
  randomCommonFileType: 'system.commonFileType',
  randomAbbreviation: 'hacker.abbreviation',
  randomAdjective: 'hacker.adjective',
  randomNoun: 'hacker.noun',
  randomVerb: 'hacker.verb',
  randomIngverb: 'hacker.ingverb',
  randomPhrase: 'hacker.phrase',
  randomDatabaseColumn: 'database.column',
  randomDatabaseType: 'database.type',
  randomDatabaseCollation: 'database.collation',
  randomDatabaseEngine: 'database.engine',
  randomAvatarImage: 'image.avatar',
  randomImageUrl: 'image.url',
});

/** Dynamic variables with a direct Janus token. */
const DIRECT_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  guid: '$uuid',
  randomUUID: '$uuid',
  timestamp: '$now:unix',
  isoTimestamp: '$now',
  randomInt: '$randomInt(0,1000)',
  randomBoolean: '$randomBool',
});

/** The Janus token for a Postman dynamic variable name (without `$`), or null. */
export function dynamicToken(name: string): string | null {
  const direct = DIRECT_TOKENS[name];
  if (direct !== undefined) return direct;
  const faker = FAKER_TABLE[name];
  return faker === undefined ? null : `$faker.${faker}`;
}

/**
 * Converts one template. Unknown dynamic variables (and any other `{{$…}}`)
 * are escaped to `{{$$…}}`, so the file still loads and the text is sent as
 * written; a name outside the variable grammar is renamed with
 * {@link toVariableName}, as its definitions are.
 */
export function convertTemplate(text: string, dialect: TemplateDialect, note: Note): string {
  if (!text.includes('{{')) return text;
  if (dialect === 'literal') return escapeLiteral(text, note);
  let out = '';
  let index = 0;
  for (;;) {
    const start = text.indexOf('{{', index);
    if (start === -1) {
      out += text.slice(index);
      break;
    }
    out += text.slice(index, start);
    const close = text.indexOf('}}', start + 2);
    if (close === -1) {
      out += text.slice(start).replaceAll('{{$', () => '{{$$');
      break;
    }
    out += convertExpression(text.slice(start + 2, close), dialect, note);
    index = close + 2;
  }
  return out;
}

function convertExpression(inner: string, dialect: TemplateDialect, note: Note): string {
  const expression = inner.trim();
  if (expression.startsWith('$')) {
    const token = dynamicToken(expression.slice(1));
    if (token !== null) return `{{${token}}}`;
    note(`{{${expression}}} has no Janus equivalent; it is kept as the literal text {{$$${expression.slice(1)}}}`);
    return `{{$$${expression.slice(1)}}}`;
  }
  const env = dialect === 'bruno' ? /^process\.env\.(.+)$/.exec(expression) : null;
  if (env?.[1] !== undefined) {
    const name = toVariableName(env[1]);
    note(`{{${expression}}} became {{${name}}}; define ${name} in an environment`);
    return `{{${name}}}`;
  }
  if (isVariableName(expression)) return `{{${inner}}}`;
  if (expression === '') {
    note('an empty {{}} was removed');
    return '';
  }
  const name = toVariableName(expression);
  note(`variable "${expression}" is outside the Janus variable grammar; it was renamed ${name}`);
  return `{{${name}}}`;
}

/** Recorded text: `{{$` is escaped; a `{{name}}` is noted, since Janus will read it as a variable. */
function escapeLiteral(text: string, note: Note): string {
  if (/\{\{\s*[A-Za-z_]/.test(text)) note('recorded text contains "{{", which Janus reads as a variable reference');
  return text.replaceAll('{{$', () => '{{$$');
}
