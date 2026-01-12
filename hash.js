import bcrypt from 'bcryptjs';

const hash = bcrypt.hashSync('P@ssword99', 12);
console.log(hash);

