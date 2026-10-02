import test from 'node:test';
import assert from 'node:assert/strict';
import { originalPrice } from '../src/pricing.mjs';

test('URL-free sentence punctuation is cheap but encoded, disguised and Unicode URLs remain conservative',()=>{
 for(const text of ['A café thought: “hello” 😀','One sentence. Another sentence.','A helpful note! Reply STOP to opt out.'])assert.equal(originalPrice(text),15000);
 for(const text of ['example.com','example.com.','https://example.com','http%3A%2F%2Fexample%2Ecom','example%2ecom','example\\.com','example\u200b.com','ｅxample.com','example。com','xn--exmple-cua.com','user at example.com','192.168.0.1','Look &period; com'])assert.equal(originalPrice(text),200000,text);
});

test('plain and ambiguous reply holds remain bounded without discounts',()=>{assert.equal(20000+originalPrice('A café thought: “hello” 😀'),35000);assert.equal(20000+originalPrice('See example.com.'),220000);});
