#!/usr/bin/env node
/**
 * Заносит сотрудников ФОТ из списка Карины (май 2026) и (с флагом --apply)
 * ретро-классифицирует уже загруженные расходы этим людям в pnl_category='payroll'.
 *
 *   node scripts/seed_employees.mjs           — занести сотрудников + ПРЕВЬЮ переклассификации (без записи операций)
 *   node scripts/seed_employees.mjs --apply   — то же + применить переклассификацию
 *
 * Идемпотентно: сотрудники upsert по lower(full_name)+company. match_pattern —
 * фамилия (нижний регистр), по ней классификатор и ФОТ-модуль сопоставляют выплаты.
 */

import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

const APPLY = process.argv.includes('--apply');

// match_pattern = «фамилия имя» (нижний регистр) — точнее, чем фамилия, чтобы не
// ловить однофамильцев (напр. ИП Рыбальченко Максим ≠ няня Рыбальченко Светлана).
// Исключения: Сунчелеева (в банке «Анастасия», не «Настя») → фамилия; Петрова
// Бухгалтерия = ИП Петрова Татьяна → «петрова татьяна»; Новикова/Диченскова → «диченскова».
const EMPLOYEES = [
  ['Аминов Игорь', 'Руководитель IT-отдела', 26245, 'ip', 'аминов игорь', 'с ИП на ИП'],
  ['Афонченко Анна', 'Юрист', 15000, 'ip', 'афонченко анна', 'с ИП на СЗ'],
  ['Барахова Любовь', 'Продавец', 102830, 'ip', 'барахова любовь', 'с ИП на СЗ'],
  ['Буркова Елена', 'Секретарь учебной части', 20000, 'ooo', 'буркова елена', 'с ООО на карту, с карты на карту'],
  ['Васильева Дина', 'Эксперт, работает со стажерами', 4200, 'ip', 'васильева дина', 'с карты на карту'],
  ['Гайнетдинова Диана', 'Куратор Клуба Метанойя', 25000, 'ip', 'гайнетдинова диана', 'с ИП на СЗ'],
  ['Курицына Полина', 'Рук отдела маркетинга с мая', 115000, 'ip', 'курицына полина', 'с ИП на СЗ'],
  ['Логинова Ирина', 'Преподаватель, куратор чата ПСИЗ', 26500, 'ooo', 'логинова ирина', 'с ООО на карту, с карты на карту'],
  ['Люфт Людмила', 'Преподаватель', 2000, 'ip', 'люфт людмила', 'зачет'],
  ['Мещенская Милена', 'Видеомонтажер', 21200, 'ip', 'мещенская милена', 'с карты на карту'],
  ['Мингазова Венера', 'Куратор Клуба Метанойя', 20000, 'ip', 'мингазова венера', 'с карты на карту'],
  ['Михайлова Александра', 'Администратор Тик-ток', 2500, 'ip', 'михайлова александра', 'с карты на карту'],
  ['Нечаева Юлия', 'Куратор Клуба Метанойя', 25000, 'ip', 'нечаева юлия', 'с карты на карту'],
  ['Новикова/Диченскова', 'Модератор Инстаграм, ВК, MAX', 7500, 'ip', 'диченскова', 'зачет'],
  ['Окатова Любовь', 'Продавец', 149123, 'ip', 'окатова любовь', 'с карты на карту'],
  ['Петрова Бухгалтерия', 'Бухгалтер + команда', 60000, 'ip', 'петрова татьяна', 'с ИП на ИП'],
  ['Рыбальченко Светлана', 'Няня (Скрипникова Наташа)', 30000, 'ip', 'рыбальченко светлана', 'с карты на карту'],
  ['Саньков Евгений', '', 5000, 'ip', 'саньков евгений', 'с карты на карту'],
  ['Сунчелеева Настя', 'Рук отдела продаж', 177200, 'ip', 'сунчелеев', 'с ИП на ИП'],
  ['Тимофеева Варвара', 'Учебный администратор', 59000, 'ip', 'тимофеева варвара', 'с ИП на СЗ'],
  ['Токарь Дарья', 'Преподаватель, консультант', 32100, 'ooo', 'токарь дарья', 'с ООО на карту, с карты на карту'],
  ['Цветкова Маргарита', 'Графический дизайнер', 56750, 'ip', 'цветкова маргарита', 'с ИП на СЗ'],
  ['Чеканова Екатерина', 'Методист ДПО', 84705, 'ooo', 'чеканова екатерина', 'с ООО на карту, с карты на карту'],
  ['Чепелева Наталья', 'Руководитель ДПО', 70000, 'ooo', 'чепелева наталья', 'с ООО на карту, с карты на карту'],
  ['Чуносова Оксана', 'СММ специалист', 73072, 'ip', 'чуносова оксана', 'с карты на карту'],
  ['Шапиро Инна', '', 15000, 'ip', 'шапиро инна', 'с карты на карту'],
];

async function loadDotEnv() {
  const raw = await readFile('.env', 'utf8').catch(() => '');
  for (const line of raw.split('\n')) {
    const m = /^\s*([A-Za-z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function fmt(kop) {
  return (Number(kop) / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2 });
}

async function main() {
  await loadDotEnv();
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, idle_timeout: 5 });
  try {
    // 1. Upsert сотрудников.
    let inserted = 0, updated = 0;
    const idByPattern = new Map();
    for (const [name, position, rub, company, pattern, pay] of EMPLOYEES) {
      const kop = BigInt(Math.round(rub * 100));
      const existing = await sql`SELECT id FROM employees WHERE company_id=${company} AND lower(full_name)=lower(${name})`;
      let id;
      if (existing.length > 0) {
        id = existing[0].id;
        await sql`UPDATE employees SET position=${position || null}, salary_monthly=${kop}, match_pattern=${pattern}, bank_details=${pay}, status='active', updated_at=NOW() WHERE id=${id}`;
        updated++;
      } else {
        const ins = await sql`INSERT INTO employees (company_id, full_name, position, salary_monthly, match_pattern, bank_details) VALUES (${company}, ${name}, ${position || null}, ${kop}, ${pattern}, ${pay}) RETURNING id`;
        id = ins[0].id;
        inserted++;
      }
      idByPattern.set(pattern, { id, name });
    }
    console.log(`Сотрудники: добавлено ${inserted}, обновлено ${updated}, всего ${EMPLOYEES.length}.`);
    const fot = EMPLOYEES.reduce((s, e) => s + e[2], 0);
    console.log(`Сумма окладов (план ФОТ/мес): ${fot.toLocaleString('ru-RU')} ₽\n`);

    // 2. Превью переклассификации существующих расходов этим людям → ФОТ.
    console.log(`=== ${APPLY ? 'ПРИМЕНЯЮ' : 'ПРЕВЬЮ (без записи)'} переклассификацию расходов → ФОТ ===`);
    let totalCount = 0, totalSum = 0;
    for (const [, , , , pattern] of EMPLOYEES) {
      const rows = await sql`
        SELECT counterparty, count(*)::int c, COALESCE(SUM(amount_rub),0)::bigint s
        FROM transactions
        WHERE deleted_at IS NULL AND flow_type='expense'
          AND counterparty ILIKE ${'%' + pattern + '%'}
          AND (pnl_category IS DISTINCT FROM 'payroll')
        GROUP BY counterparty`;
      if (rows.length === 0) continue;
      for (const r of rows) {
        totalCount += Number(r.c); totalSum += Number(r.s);
        console.log(`  «${pattern}» ← "${r.counterparty}": ${r.c} оп., ${fmt(r.s)} ₽`);
      }
      if (APPLY) {
        const emp = idByPattern.get(pattern);
        await sql`
          UPDATE transactions
          SET pnl_category='payroll', employee_id=${emp.id}::uuid, is_personal=false, needs_review=false, updated_at=NOW()
          WHERE deleted_at IS NULL AND flow_type='expense'
            AND counterparty ILIKE ${'%' + pattern + '%'}
            AND (pnl_category IS DISTINCT FROM 'payroll')`;
      }
    }
    console.log(`\nИтого ${APPLY ? 'переклассифицировано' : 'будет переклассифицировано'}: ${totalCount} операций на ${fmt(totalSum)} ₽`);
    if (!APPLY) console.log('Запусти с --apply, чтобы применить.');
  } catch (e) {
    console.error('ОШИБКА:', e.message);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main();
