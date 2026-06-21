import * as asn1js from "asn1js";
import {
  AttributeTypeAndValue,
  AuthenticatedSafe,
  BasicConstraints,
  CertBag,
  Certificate,
  ContentInfo,
  Extension,
  PFX,
  PKCS8ShroudedKeyBag,
  PrivateKeyInfo,
  SafeBag,
  SafeContents,
  getCrypto,
  id_CertBag_X509Certificate
} from "pkijs";

const KEY_BAG_ID = "1.2.840.113549.1.12.10.1.2";
const CERT_BAG_ID = "1.2.840.113549.1.12.10.1.3";

function textToArrayBuffer(value) {
  return new TextEncoder().encode(value).buffer;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function randomSerialNumber() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[0] &= 0x7f;
  if (bytes[0] === 0) bytes[0] = 1;
  return bytes.buffer;
}

function addCommonName(target, commonName) {
  target.typesAndValues.push(new AttributeTypeAndValue({
    type: "2.5.4.3",
    value: new asn1js.Utf8String({ value: commonName })
  }));
}

function buildKeyUsageExtension() {
  const keyUsageBuffer = new ArrayBuffer(1);
  const keyUsageView = new Uint8Array(keyUsageBuffer);
  keyUsageView[0] |= 0x04;
  keyUsageView[0] |= 0x02;
  const keyUsage = new asn1js.BitString({ valueHex: keyUsageBuffer });
  return new Extension({
    extnID: "2.5.29.15",
    critical: true,
    extnValue: keyUsage.toBER(false),
    parsedValue: keyUsage
  });
}

function buildBasicConstraintsExtension() {
  const basicConstraints = new BasicConstraints({ cA: true });
  return new Extension({
    extnID: "2.5.29.19",
    critical: true,
    extnValue: basicConstraints.toSchema().toBER(false),
    parsedValue: basicConstraints
  });
}

async function createCertificate(commonName, years) {
  const cryptoEngine = getCrypto(true);
  const algorithm = {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  };
  const keys = await cryptoEngine.generateKey(algorithm, true, ["sign", "verify"]);
  const certificate = new Certificate();
  certificate.version = 2;
  certificate.serialNumber = new asn1js.Integer({ valueHex: randomSerialNumber() });
  addCommonName(certificate.issuer, commonName);
  addCommonName(certificate.subject, commonName);
  certificate.notBefore.value = new Date();
  const notAfter = new Date(certificate.notBefore.value);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + years);
  certificate.notAfter.value = notAfter;
  certificate.extensions = [
    buildBasicConstraintsExtension(),
    buildKeyUsageExtension()
  ];
  await certificate.subjectPublicKeyInfo.importKey(keys.publicKey);
  await certificate.sign(keys.privateKey, "SHA-256");
  return { certificate, privateKey: keys.privateKey };
}

async function buildP12(certificate, privateKey, passphrase) {
  const cryptoEngine = getCrypto(true);
  const pkcs8 = await cryptoEngine.exportKey("pkcs8", privateKey);
  const privateKeyInfo = PrivateKeyInfo.fromBER(pkcs8);
  const shroudedKeyBag = new PKCS8ShroudedKeyBag({ parsedValue: privateKeyInfo });
  const password = textToArrayBuffer(passphrase);
  await shroudedKeyBag.makeInternalValues({
    password,
    contentEncryptionAlgorithm: {
      name: "AES-CBC",
      length: 256
    },
    hmacHashAlgorithm: "SHA-256",
    iterationCount: 100000
  });

  const certBag = new CertBag({
    certId: id_CertBag_X509Certificate,
    certValue: new asn1js.OctetString({ valueHex: certificate.toSchema().toBER(false) }),
    parsedValue: certificate
  });
  const safeContents = new SafeContents({
    safeBags: [
      new SafeBag({ bagId: KEY_BAG_ID, bagValue: shroudedKeyBag }),
      new SafeBag({ bagId: CERT_BAG_ID, bagValue: certBag })
    ]
  });
  const authenticatedSafe = new AuthenticatedSafe({
    parsedValue: {
      safeContents: [{ privacyMode: 0, value: safeContents }]
    }
  });
  await authenticatedSafe.makeInternalValues({ safeContents: [{}] });
  const pfx = new PFX({
    parsedValue: {
      integrityMode: 0,
      authenticatedSafe
    }
  });
  await pfx.makeInternalValues({
    password,
    iterations: 100000,
    pbkdf2HashAlgorithm: { name: "SHA-256" },
    hmacHashAlgorithm: "SHA-256"
  });
  return pfx.toSchema().toBER(false);
}

export async function generateMitmCaP12({
  commonName = "SubPilot MITM CA",
  passphrase,
  years = 20
} = {}) {
  const cleanPassphrase = String(passphrase || "").trim();
  if (!cleanPassphrase) throw new Error("CA passphrase is required");
  const cleanCommonName = String(commonName || "").trim() || "SubPilot MITM CA";
  const { certificate, privateKey } = await createCertificate(cleanCommonName, years);
  const p12 = await buildP12(certificate, privateKey, cleanPassphrase);
  return {
    caP12: arrayBufferToBase64(p12),
    fileName: `${cleanCommonName.replace(/[^A-Za-z0-9._-]+/g, "-")}.p12`
  };
}
